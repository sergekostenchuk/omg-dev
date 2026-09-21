// Общая сборка ленты ревью для карточки «OM · Обсуждение»: один код и для страницы ComfyUI, и для export/import (Node).
// Карточка = история (пишется руками, хранится в om-design.json) + черта + лента (проекция журнала, всегда пересобирается).
export const DISCUSSION_TITLE = "OM · Обсуждение";
export const MARKER_KEY = "══════════ ЛЕНТА РЕВЬЮ";
export const MARKER = MARKER_KEY + " · из журнала ~/.asvp-review, обновляется сама · свои реплики пишите ВЫШЕ этой черты ══════════";
// Записи журнала до №75 включительно (круги 1–3 OMG-ORDER) уже внесены в историю карточки руками — в ленту идут следующие.
export const FEED_FROM_LINE = 76;

const WHO = { claude: "Claude Code", codex: "Codex (харнесс)", "codex-omg": "Codex", owner: "Владелец" };
const KIND = { "review-request": "запрос на ревью", verdict: "вердикт", answer: "ответ", question: "вопрос", note: "заметка", ack: "принято", status: "статус", blocker: "стоп", task: "задание", authorization: "разрешение" };

export function isDiscussion(title) { return String(title ?? "").startsWith(DISCUSSION_TITLE); }

/** История без ленты: всё до черты. Текста без черты не меняет. */
export function splitHistory(text) { const t = String(text ?? ""); const i = t.indexOf(MARKER_KEY); return i < 0 ? t : t.slice(0, i).replace(/\s+$/, ""); }

export function renderFeed(items, status) {
  const rows = (items ?? []).filter(it => Number(it.n) >= FEED_FROM_LINE);
  const head = status ? `(${status})` : rows.length ? `(записей: ${rows.length}, последняя №${rows[rows.length - 1].n})` : "(новых записей пока нет)";
  const body = rows.map(it => {
    const [d, tm] = String(it.ts ?? "").split("T"); const [y, m, day] = (d || "").split("-");
    const when = day ? `${day}.${m}.${y}${tm ? " " + tm.slice(0, 5) : ""}` : "";
    return `──────────\n[${when} · ${WHO[it.from] || it.from} → ${WHO[it.to] || it.to} · ${KIND[it.kind] || it.kind} · ${it.topic} · №${it.n}]\n${String(it.text ?? "").trim()}`;
  }).join("\n\n");
  return head + (body ? "\n\n" + body : "");
}

/** Полный текст карточки: история + черта + свежая лента. Повторный вызов даёт тот же результат. */
export function withFeed(text, items, status) { return splitHistory(text) + "\n\n" + MARKER + "\n" + renderFeed(items, status); }
