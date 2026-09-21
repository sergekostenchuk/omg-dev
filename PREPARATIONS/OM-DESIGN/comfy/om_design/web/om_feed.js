// Живая карточка «OM · Обсуждение»: раз в 5 секунд подтягивает из журнала запросы и вердикты (темы OMG-*).
// Меняет только текст этой карточки ниже черты; остальной граф не трогает; пока в карточке печатают — не вмешивается.
import { isDiscussion, withFeed } from "./feed_render.js";

const POLL_MS = 5000;
let lastSig = "";

async function getApp() {
  try { return (await import("../../scripts/app.js")).app; } catch { return window.comfyAPI?.app?.app ?? window.app ?? null; }
}
function discussionNote(app) {
  const nodes = app?.graph?._nodes ?? app?.graph?.nodes ?? [];
  return nodes.find(n => (n.type === "Note" || n.type === "MarkdownNote") && isDiscussion(n.title)) ?? null;
}
async function tick(app) {
  const note = discussionNote(app); if (!note) return;              // открыта другая схема — ничего не делаем
  const w = note.widgets?.[0]; if (!w) return;
  const field = w.element ?? w.inputEl ?? null;
  if (field && (document.activeElement === field || field.contains?.(document.activeElement))) return;   // владелец печатает
  let items = null, status = null;
  try {
    const r = await fetch("/om_design/feed", { cache: "no-store" }); if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    if (d.ok) items = d.items; else status = d.code === "channel_missing" ? "журнал ревью не найден — лента не обновляется" : "журнал ревью не читается — лента не обновляется";
  } catch { status = "нет связи с журналом ревью — показана история без ленты"; }
  const sig = status ?? (items.length + ":" + (items.length ? items[items.length - 1].n : 0));
  const current = String(w.value ?? "");
  if (sig === lastSig && current.includes("══════════ ЛЕНТА РЕВЬЮ")) return;
  const next = withFeed(current, items ?? [], status);
  lastSig = sig;
  if (next === current) return;
  w.value = next; if (field && "value" in field && field.value !== next) field.value = next;
  app.graph?.setDirtyCanvas?.(true, true);
}
getApp().then(app => { if (!app) { console.warn("[om_design] приложение ComfyUI не найдено — лента ревью выключена"); return; }
  setInterval(() => tick(app).catch(e => console.warn("[om_design] лента ревью:", e)), POLL_MS); });
