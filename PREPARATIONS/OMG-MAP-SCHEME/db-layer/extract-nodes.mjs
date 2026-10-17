// Выгрузка узлов схемы (STAGES) в JSON: ключ, тип, заголовок, роль, вход/выход, строки «Действие» и «Задача».
import { readFileSync, writeFileSync } from "node:fs";
const html = readFileSync(new URL("../omg-pass-map.src.html", import.meta.url), "utf8");
const a = html.indexOf("var STAGES=["), b = html.indexOf("var CROSS=[");
const GAP = 1, TASK = 2;
function snake(list) { return list; }
function lbl(e) { return e; }
function zrow(list) { return list; }
function grid(list) { return list; }
function col(list) { return list; }
const STAGES = eval(html.slice(a + 11, b).trim().replace(/;\s*$/, ""));
const out = [];
function walk(it, key, kind) {
  const acts = (it.d || []).filter(r => /Действие|Задача|Сейчас|Как сейчас/.test(r[0])).map(r => r[0] + ": " + r[1]);
  out.push({ key, kind, t: it.t, role: it.role || it.n, io: it.io, sum: it.sum || it.bh || "", refs: acts });
  (it.nodes || []).forEach(n => walk(n, key + "." + n.id, "node"));
  (it.subs || []).forEach(s => walk(s, key + "." + s.id, "sub"));
}
STAGES.forEach(s => walk(s, s.id, "stage"));
writeFileSync(new URL("./map-nodes.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(out.length, "элементов;", out.filter(x => x.key.startsWith("in") || x.key.startsWith("disc") || x.key.startsWith("con") || x.key.startsWith("ndisc")).length, "в ранних стадиях");
