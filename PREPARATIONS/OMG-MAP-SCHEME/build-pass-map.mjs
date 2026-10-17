#!/usr/bin/env node
// Сборка omg-pass-map-2026-10-14.html из omg-pass-map.src.html + omg-pass-map-texts.json.
// Слои: схема — .src.html (правится вручную/генератором), тексты — .json (правится отдельно).
// Вставляет ["Простыми словами",…],["На примере",…] первыми строками d:[…] каждого элемента.
// Ключ — полный точечный путь (in.a.a1, disc.d2.n6, con.c3.a.n9 …), как в reg().
// Печатает «узлы без описания» и «описания без узла»; код выхода 1, если списки не пусты.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const SRC = join(dir, "omg-pass-map.src.html");
const TEXTS = join(dir, "omg-pass-map-texts.json");
const OUT = join(dir, "omg-pass-map-2026-10-14.html");

const html = readFileSync(SRC, "utf8");
const texts = JSON.parse(readFileSync(TEXTS, "utf8"));

const i0 = html.indexOf("var STAGES=[");
const i1 = html.indexOf("var CROSS=[");
if (i0 < 0 || i1 < 0 || i1 <= i0) { console.error("нет границ STAGES/CROSS"); process.exit(2); }
const src = html.slice(i0, i1);
const n = src.length;

// Сканер литерала: пропускает строки и комментарии, ведёт стек объектов с id.
function readString(pos, q) {
  let j = pos + 1;
  while (j < n) {
    const c = src[j];
    if (c === "\\") { j += 2; continue; }
    if (c === q) return j + 1;
    j++;
  }
  throw new Error("unclosed string at " + pos);
}

const brackets = [];   // '{' или '['
const objStack = [];   // id объекта или null
const inserts = [];    // [{pos (после 'd:['), path}]
const consumed = new Set();
const missing = [];

let i = 0;
while (i < n) {
  const c = src[i];
  if (c === '"' || c === "'") { i = readString(i, c); continue; }
  if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); if (i < 0) break; continue; }
  if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 2; continue; }
  if (c === "{") {
    brackets.push("{");
    const m = /^\{\s*id:"([^"]+)"/.exec(src.slice(i));
    objStack.push(m ? m[1] : null);
    i += 1; continue;
  }
  if (c === "[") { brackets.push("["); i += 1; continue; }
  if (c === "}") {
    if (brackets.pop() !== "{") { console.error("stack mismatch } at", i); process.exit(2); }
    objStack.pop(); i += 1; continue;
  }
  if (c === "]") {
    if (brackets.pop() !== "[") { console.error("stack mismatch ] at", i); process.exit(2); }
    i += 1; continue;
  }
  if (src.startsWith('id:"', i) && brackets[brackets.length - 1] === "{") {
    const m = /^id:"([^"]+)"/.exec(src.slice(i));
    if (m && objStack[objStack.length - 1] === null) {
      objStack[objStack.length - 1] = m[1]; i += m[0].length; continue;
    }
  }
  if (src.startsWith("d:[", i)) {
    const path = objStack.filter(Boolean).join(".");
    inserts.push({ pos: i + 3, path });
    brackets.push("[");
    i += 3; continue;
  }
  i += 1;
}
if (brackets.length) { console.error("незакрытые скобки в STAGES"); process.exit(2); }

// Вставка: пары — первыми строками d (как в исходнике). Идём от конца к началу.
let out = html;
for (const { pos, path } of inserts.reverse()) {
  const rec = texts[path];
  if (!rec) { missing.push(path); continue; }
  consumed.add(path);
  const lit = '["Простыми словами",' + JSON.stringify(rec.plain) +
              '],["На примере",' + JSON.stringify(rec.example) + "],";
  out = out.slice(0, i0 + pos) + lit + out.slice(i0 + pos);
}

const orphans = Object.keys(texts).filter((k) => !consumed.has(k));

console.log("узлов без описания:", missing.length, missing.length ? missing.join(" ") : "");
console.log("описаний без узла:", orphans.length, orphans.length ? orphans.join(" ") : "");

if (missing.length || orphans.length) process.exit(1);
// Слой базы: код — db-layer/db-layer.js (всегда), данные — db-layer/db-layer.json (если есть; иначе слой выключен).
const DBJS = join(dir, "db-layer", "db-layer.js");
const DBJSON = join(dir, "db-layer", "db-layer.json");
const dbjs = readFileSync(DBJS, "utf8");
let dbdata = "null";
try { dbdata = JSON.stringify(JSON.parse(readFileSync(DBJSON, "utf8"))).replace(/</g, "\\u003c"); } catch (e) { if (e.code !== "ENOENT") throw e; }
if (!out.includes("/*@DBLAYERJS@*/")) { console.error("нет места слоя базы /*@DBLAYERJS@*/"); process.exit(2); }
out = out.split("/*@DBLAYERJS@*/").join(dbjs.split("/*@DBLAYER@*/null").join(dbdata));
console.log("слой базы:", dbdata === "null" ? "данных нет — выключен" : (JSON.parse(dbdata).kinds || []).length + " видов записей");
writeFileSync(OUT, out);
console.log("собран:", OUT, "—", out.length, "знаков");
