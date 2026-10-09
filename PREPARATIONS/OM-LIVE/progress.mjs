#!/usr/bin/env node
// Прогресс живого прохода omg-live одной командой: node ~/OMG/PREPARATIONS/OM-LIVE/progress.mjs
// Только чтение: журнал сторожа, журнал заслона, процессы и om-state через CLI продукта (команда чтения).
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

const OMG = `${homedir()}/OMG/.omg`;
const WATCH = `${OMG}/live-watch.jsonl`, GATE = `${OMG}/live-gate/gate-log.jsonl`;
const LIMITS = { calls: 80, block: 33, input: 8_000_000, minutes: 1800 };
const ENDS = new Set(["ended", "stopped", "terminated", "not-started", "peer-lost-before-start", "refused-closed"]);

const lines = file => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const hm = iso => { const d = new Date(iso), t = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })} ${t}`; };
const num = n => n.toLocaleString("ru-RU");

const watch = lines(WATCH).filter(e => e.role === "watch");
// Отрезки: armed → ближайший конец; открытый — идёт сейчас.
const segments = [];
for (const e of watch) {
  if (e.event === "armed") segments.push({ start: e.at, end: null, how: null, calls: [] });
  else if (segments.length && !segments.at(-1).end) {
    if (e.event === "call") segments.at(-1).calls.push(e);
    else if (ENDS.has(e.event)) Object.assign(segments.at(-1), { end: e.at, how: e.event });
  }
}
const calls = segments.flatMap(s => s.calls);
const parse = e => {
  const line = e.line ?? "";
  const m = line.match(/^вызов (\d+): ([^|]+?) → ([^;]+);/), inp = line.match(/вход (\d+) \(кэш/), model = line.match(/модель (\d+) с/);
  return { at: e.at, n: m?.[1] ?? "?", what: (m?.[2] ?? e.purpose ?? "?").trim(), outcome: (m?.[3] ?? "?").trim(),
    owner: (e.owner ?? "").replace("block:", ""), input: inp ? Number(inp[1]) : 0, model: model ? Number(model[1]) : 0 };
};
const rows = calls.map(parse);

// Накопленное за весь проход ветви.
const byBlock = {};
for (const r of rows) byBlock[r.owner] = (byBlock[r.owner] ?? 0) + 1;
const totalInput = rows.reduce((s, r) => s + r.input, 0);
const now = Date.now();
const usedMin = segments.reduce((s, g) => s + ((g.end ? Date.parse(g.end) : now) - Date.parse(g.start)) / 60_000, 0);
const current = segments.at(-1);
const running = current && !current.end;

// Процессы и текущий шаг.
const alive = pattern => { try { return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length > 0; } catch { return false; } };
const watchAlive = alive("live-gate/live-watch.mjs --role watch"), guardAlive = alive("live-gate/live-watch.mjs --role guard");
const driverAlive = alive(`${OMG}/runner-live/dist/src/cli.js command`);
let step = null;
try {
  const out = execFileSync("node", [`${OMG}/runner-live/dist/src/cli.js`, "command", `${OMG}/state.sqlite`],
    { input: JSON.stringify({ type: "om-state", project: "omg-live" }), encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 60_000 });
  const v = JSON.parse(out).value, st = v.run.value.state;
  step = { phase: st.phase, action: st.step?.action ?? null, attempt: st.step?.attempt ?? null, wait: st.wait?.code ?? null,
    stopped: Boolean(v.control.control?.value?.stop) };
} catch { step = null; }

// Вызов в полёте: последнее разрешение заслона без закрытой строки сторожа.
const allows = lines(GATE).filter(g => g.decision === "allow");
const lastAllow = allows.at(-1);
const inFlight = running && lastAllow && !calls.some(c => c.id === lastAllow.call) && Date.parse(lastAllow.at) >= Date.parse(current.start);

const out = [];
out.push(`ЖИВОЙ ПРОХОД omg-live — ${new Date().toLocaleString("ru-RU")}`);
out.push(running ? `Идёт отрезок с ${hm(current.start)} (${Math.round((now - Date.parse(current.start)) / 60_000)} мин).`
  : `Проход не идёт: последний отрезок ${current ? `${hm(current.start)}–${hm(current.end)}, конец: ${current.how}` : "—"}.`);
out.push(`Процессы: движок ${driverAlive ? "жив" : "нет"}, сторож ${watchAlive ? "жив" : "нет"}, охранник ${guardAlive ? "жив" : "нет"}.`);
if (step) out.push(`Сейчас: фаза ${step.phase}${step.action ? `, шаг ${step.action}` : ""}${step.attempt ? ` (попытка ${step.attempt})` : ""}${step.wait ? `, ожидание ${step.wait}` : ""}${step.stopped ? ", СТОП стоит" : ""}.`);
if (inFlight) out.push(`Вызов модели в работе с ${hm(lastAllow.at)} (блок ${lastAllow.owner}).`);
out.push("");
out.push(`Пределы за весь проход: вызовов ${calls.length}/${LIMITS.calls}; вход ${num(totalInput)} из ${num(LIMITS.input)}; время ${Math.round(usedMin)} из ${LIMITS.minutes} мин.`);
out.push(`По блокам: ${Object.entries(byBlock).map(([b, n]) => `${b} ${n}/${LIMITS.block}`).join(", ") || "—"}.`);
if (running) {
  const seg = rows.filter(r => Date.parse(r.at) >= Date.parse(current.start));
  const el = (now - Date.parse(current.start)) / 1000, model = seg.reduce((s, r) => s + r.model, 0);
  out.push(`Этот отрезок: вызовов ${seg.length}; модель ${Math.round(model / 60)} мин из ${Math.round(el / 60)} (${(model / el * 100).toFixed(0)}%), остальное — работа движка.`);
}
out.push("");
out.push("Вызовы (время · блок / операция → исход · вход · модель):");
rows.forEach((r, i) => { if (i >= rows.length - 15) out.push(`  ${hm(r.at)}  ${i + 1}. ${r.what} → ${r.outcome} · ${num(r.input)} · ${r.model} с`); });
console.log(out.join("\n"));
