#!/usr/bin/env node
// Сторож простоя живого прохода: node ~/OMG/PREPARATIONS/OM-LIVE/stall-watch.mjs [--threshold 60] [--sample 20] [--pid <pid движка>]
// Диагностика на копии: --pid <pid> --db <копия> --always (профиль непрерывно окнами по --sample с) --log <файл> --profiles <папка>
// Если движок дольше порога не пишет в базу и не ждёт модель — снимает профиль процессора с идущего процесса
// (инспектор по SIGUSR1, только чтение, проход не останавливается) и пишет, какое место кода занимает время.
// Журнал: ~/OMG/.omg/stall-watch.jsonl; профили: ~/OMG/.omg/stall-profiles/*.cpuprofile (открываются в Chrome DevTools).
import { statSync, existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1]]] : a), []));
const OMG = `${homedir()}/OMG/.omg`, DB = args.db ?? `${OMG}/state.sqlite`, ALWAYS = "always" in args, LOG = args.log ?? `${OMG}/stall-watch.jsonl`, PROFILES = args.profiles ?? `${OMG}/stall-profiles`;
const THRESHOLD = Number(args.threshold ?? 60) * 1000, SAMPLE = Number(args.sample ?? 20) * 1000, POLL = 15_000, PORT = 9229;
mkdirSync(PROFILES, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = row => { const line = JSON.stringify({ at: new Date().toISOString(), ...row }); appendFileSync(LOG, line + "\n"); console.log(line.slice(0, 600)); };

const ps = () => execFileSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" }).split("\n").filter(Boolean)
  .map(l => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return m && { pid: Number(m[1]), pgid: Number(m[2]), cmd: m[3] }; }).filter(Boolean);
const engine = () => {
  if (args.pid) return ps().find(p => p.pid === Number(args.pid)) ?? null;
  return ps().find(p => p.cmd.includes("runner-live/dist/src/cli.js command") && !p.cmd.startsWith("/usr/bin/time")) ?? null;
};
// Последняя запись в базу: время изменения файла базы или его WAL (базу не открываем).
const lastWrite = () => Math.max(...[DB, `${DB}-wal`].filter(existsSync).map(f => statSync(f).mtimeMs));
// Ждёт ли движок модель: в группе процесса прохода есть процесс codex.
const waitingModel = e => ps().some(p => p.pgid === e.pgid && p.pid !== e.pid && /(^|\/)codex(\s|$)|codex exec/.test(p.cmd));

async function profile(e) {
  let list = null;
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch {}
  if (!list) { process.kill(e.pid, "SIGUSR1"); for (let i = 0; i < 20 && !list; i++) { await sleep(250); try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch {} } }
  const target = list?.[0]?.webSocketDebuggerUrl;
  if (!target) throw new Error("инспектор не ответил");
  const ws = new WebSocket(target); let id = 0; const waiting = new Map();
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
  const send = (method, params = {}) => new Promise(r => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  await send("Profiler.enable"); await send("Profiler.setSamplingInterval", { interval: 1000 }); await send("Profiler.start");
  await sleep(SAMPLE);
  const { result } = await send("Profiler.stop"); await send("Profiler.disable"); ws.close();
  return result.profile;
}

function summarize(p) {
  const nodes = new Map(p.nodes.map(n => [n.id, n])), parent = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const key = n => { const f = n.callFrame, file = (f.url || "").replace(/^.*\/dist\//, "").replace(/^file:\/\//, ""); return `${f.functionName || "(anon)"} ${file}:${f.lineNumber + 1}`; };
  const engineFrame = n => /\/dist\/src\//.test(n.callFrame.url || "");
  const self = new Map(), incl = new Map(), stacks = new Map(); let total = 0;
  for (const s of p.samples) {
    total++; const leaf = nodes.get(s); const k = key(leaf); self.set(k, (self.get(k) ?? 0) + 1);
    const seen = new Set(), path = [];
    for (let id = s; id !== undefined; id = parent.get(id)) {
      const n = nodes.get(id); if (!n || n.callFrame.functionName === "(root)") continue;
      const kk = key(n); if (engineFrame(n) && !seen.has(kk)) { seen.add(kk); incl.set(kk, (incl.get(kk) ?? 0) + 1); }
      if (engineFrame(n) && path.length < 12 && path.at(-1) !== n.callFrame.functionName) path.push(n.callFrame.functionName || "(anon)");
    }
    const sk = path.join(" ← "); stacks.set(sk, (stacks.get(sk) ?? 0) + 1);
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${Math.round(v / total * 100)}% ${k}`);
  return { samples: total, inclusive: top(incl, 25), self: top(self, 12), stacks: top(stacks, 5) };
}

log({ event: "start", threshold: THRESHOLD / 1000, sample: SAMPLE / 1000 });
let lastProfiled = 0;
for (;;) {
  const e = engine();
  if (!e) { await sleep(POLL); continue; }
  const quiet = Date.now() - lastWrite();
  if (ALWAYS || (quiet >= THRESHOLD && !waitingModel(e) && Date.now() - lastProfiled >= THRESHOLD)) {
    try {
      const prof = await profile(e), file = `${PROFILES}/${new Date().toISOString().replace(/[:.]/g, "-")}.cpuprofile`;
      writeFileSync(file, JSON.stringify(prof));
      log({ event: "stall", quietSec: Math.round(quiet / 1000), pid: e.pid, profile: file, ...summarize(prof) });
    } catch (error) { log({ event: "profile-error", quietSec: Math.round(quiet / 1000), error: String(error?.message ?? error) }); }
    lastProfiled = Date.now();
    if (ALWAYS) continue;
  }
  await sleep(POLL);
}
