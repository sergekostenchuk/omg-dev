// Уровень 2 · M4, редакция 4 — исправления ПОСЛЕ третьего вердикта Codex (четвёртый круг ревью не запрашивается, стоп-правило):
// три дефекта исполняемой спецификации закрыты кодом и тестами 9–12; порядок связей на карте приведён к порядку кода.
import { readFileSync, writeFileSync } from "node:fs";
import { W, heightOf } from "./vocab.mjs";
const s = JSON.parse(readFileSync("om-design.json", "utf8")); const by = id => s.nodes.find(n => n.id === id);
const rep = (id, key, from, to) => { const f = by(id).fields; if (!f[key].includes(from)) throw new Error(`не найдено в ${id}.${key}: ${from.slice(0, 50)}`); f[key] = f[key].replace(from, to); by(id).size = [W, heightOf(by(id).type, f)]; };
const point = (n, from, to, kind) => { const e = s.edges[n - 1]; e.from = from; e.to = to; e.kind = kind; };
// порядок кода: заполнения → сборка → сохранение кандидата → принятие. F4.1 принятый каркас не пишет.
point(78, "st-frame", "f4-accepted", "record");      // принятый каркас (признаки identity) ЧИТАЕТ F4.2
point(90, "f4-assemble", "st-candidate", "record");  // кандидата сохраняет сборщик, когда известен хэш графа
point(96, "st-proposal", "f4-assemble", "record");   // сборщик читает состав предложений
rep("st-candidate", "что хранит", "{ project, level, graphHash, fills[]", "{ project, level, graphHash, graph — САМ проверенный граф, fills[]");
rep("st-candidate", "что хранит", " Исполняемая спецификация:", " Сохраняет запись сборщик F4.5 после успешной проверки, когда известен хэш графа. Принимается только граф ИЗ ЭТОЙ записи: цепочка «граф → его хэш → запись кандидата → исход G3 для этой записи»; подмена объекта после проверки ничего не даёт (тест 9). proposals[] — точные ссылки {id, revision, hash} проверенных ревизий предложений. Исполняемая спецификация:");
rep("f4-input", "что делает", "Предложения status proposed для ЭТОЙ базы", "Допускаются ТОЛЬКО предложения status proposed — иначе отказ proposal_not_proposed: отклонённое предложение повторно не подаётся, нужно новое (тест 11); этот проверенный набор идёт во все шаги. Предложения для ЭТОЙ базы");
rep("f4-input", "что делает", "каркас при этом НЕ переписывается, кандидат сохраняется отдельной записью frame-candidate.", "каркас при этом НЕ переписывается; кандидата сохраняет сборщик F4.5.");
rep("f4-assemble", "что делает", "принятое определение меняется только если его id назван в redefines;", "принятое определение — и ЛОКАЛЬНАЯ СВЯЗЬ тоже — меняется только если его id назван в redefines (тест 12: замена операции с переопределением её локальной связи принимается);");
rep("f4-assemble", "что делает", " Тесты: три горизонта приняты", " После успешной проверки сборщик сохраняет запись frame-candidate: граф, его хэш, заполнения, базу и точные ссылки предложений. Тесты: три горизонта приняты");
rep("f4-accept", "что делает", "settleCandidate(candidate, запись кандидата, исход G3). Проход:", "settleCandidate(точная ссылка записи кандидата, исход G3). Исход G3 выдан на ТОЧНУЮ запись: нет такой ревизии или хэша → candidate_missing; хэш графа в записи не равен graphHash → candidate_graph_mismatch; принимается граф из записи, а не переданный объект. Предложения охраняются по ссылкам, сохранённым в кандидате, а не по текущим головам: изменённое после сборки предложение даёт input_stale, и ни одна запись транзакции не применяется (тест 10). Запоздавший отказ по предложениям, которые уже в другой ревизии или статусе, ничего не меняет (тест 11). Проход:");
const g3 = by("gate-l2").fields; if (!g3["коды отказа"].includes("proposal_not_proposed")) g3["коды отказа"] = g3["коды отказа"].replace("proposal_base_stale;", "proposal_base_stale; proposal_not_proposed; candidate_missing; candidate_graph_mismatch;"); by("gate-l2").size = [W, heightOf("gate", g3)];
for (const gid of new Set(s.nodes.map(n => n.group).filter(Boolean))) { const ns = s.nodes.filter(n => n.group === gid).sort((a, b) => a.pos[1] - b.pos[1]); let yy = ns[0].pos[1]; for (const n of ns) { n.pos[1] = yy; yy += n.size[1] + 110; }
  const g = s.groups.find(g => g.id === gid || String(g.title).startsWith(gid)); if (g) g.bounding = [ns[0].pos[0] - 40, ns[0].pos[1] - 80, W + 80, yy - 110 - ns[0].pos[1] + 140]; }
writeFileSync("om-design.json", JSON.stringify(s, null, 1)); console.log("редакция 4:", [78, 90, 96].map(n => `№${n} ${s.edges[n - 1].from} → ${s.edges[n - 1].to}`).join("; "));
