// Чтение журнала ревью для export (Node). Те же правила, что у маршрута /om_design/feed: темы OMG-*, только завершённые строки.
import { readFileSync } from "node:fs"; import { homedir } from "node:os"; import { join } from "node:path";
export function readFeedItems(path = join(process.env.ASVP_REVIEW_HOME || join(homedir(), ".asvp-review"), "channel.ndjson")) {
  let raw; try { raw = readFileSync(path, "utf8"); } catch (e) { return { ok: false, status: e.code === "ENOENT" ? "журнал ревью не найден при экспорте" : "журнал ревью не читается при экспорте", items: [] }; }
  const items = []; const lines = raw.split("\n"); lines.pop();                       // хвост без перевода строки — недописан
  lines.forEach((line, i) => { if (!line.trim()) return; let d; try { d = JSON.parse(line); } catch { return; }
    if (!d || typeof d !== "object" || Array.isArray(d) || !String(d.topic ?? "").startsWith("OMG-")) return;
    items.push({ n: i + 1, ts: String(d.ts ?? "").slice(0, 19), from: String(d.from ?? ""), to: String(d.to ?? ""), kind: String(d.kind ?? ""), topic: String(d.topic ?? ""), text: String(d.text ?? "") }); });
  return { ok: true, status: null, items };
}
