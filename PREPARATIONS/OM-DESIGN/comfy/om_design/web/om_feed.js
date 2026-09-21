// Лента ревью карты OM-DESIGN: проекция журнала ~/.asvp-review/channel.ndjson (темы OMG-*). Только чтение; граф не трогает.
(function () {
  const POLL_MS = 5000, KEY = "omFeed.collapsed", SEEN = "omFeed.seen";
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch { /* приватное окно — панель работает без памяти */ } };
  const el = (tag, css, text) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text !== undefined) e.textContent = text; return e; };

  const box = el("div", "position:fixed;right:12px;bottom:12px;z-index:9999;width:460px;max-width:calc(100vw - 24px);font:13px/1.45 -apple-system,Segoe UI,sans-serif;color:#e6e6e6;background:#1b1f24;border:1px solid #3a424d;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.45);display:flex;flex-direction:column;");
  const head = el("div", "display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;user-select:none;border-bottom:1px solid #2c333c;");
  const title = el("div", "font-weight:600;flex:1;", "OM · ревью (Claude Code ↔ Codex)");
  const badge = el("span", "display:none;background:#c0392b;color:#fff;border-radius:10px;padding:0 7px;font-size:12px;");
  const state = el("span", "font-size:12px;color:#8b98a5;");
  const body = el("div", "overflow:auto;max-height:60vh;padding:8px 10px;");
  head.append(title, badge, state); box.append(head, body);

  let collapsed = get(KEY, "0") === "1", lastTotal = -1, seen = Number(get(SEEN, "0")) || 0, lastSig = "";
  const apply = () => { body.style.display = collapsed ? "none" : "block"; if (!collapsed) { seen = Math.max(seen, lastTotal); set(SEEN, String(seen)); badge.style.display = "none"; } };
  head.addEventListener("click", () => { collapsed = !collapsed; set(KEY, collapsed ? "1" : "0"); apply(); });

  const WHO = { claude: "Claude Code", codex: "Codex (харнесс)", "codex-omg": "Codex · ревью карты", owner: "Владелец" };
  const KIND = { "review-request": "запрос на ревью", verdict: "вердикт", answer: "ответ", question: "вопрос", note: "заметка", ack: "принято", status: "статус", blocker: "стоп" };
  function render(items) {
    const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
    body.replaceChildren();
    if (!items.length) body.append(el("div", "color:#8b98a5;", "В журнале пока нет записей по темам OMG-*."));
    for (const it of items) {
      const mine = it.from === "claude";
      const card = el("div", "margin:0 0 10px;padding:8px 10px;border-radius:6px;border-left:3px solid " + (it.kind === "verdict" ? "#d4a017" : mine ? "#3b82c4" : "#4caf50") + ";background:#232930;");
      card.append(el("div", "font-size:12px;color:#9fb0c0;margin-bottom:4px;", `#${it.n} · ${it.ts.replace("T", " ")} · ${WHO[it.from] || it.from} → ${WHO[it.to] || it.to} · ${KIND[it.kind] || it.kind} · ${it.topic}`));
      card.append(el("div", "white-space:pre-wrap;word-break:break-word;", it.text));   // textContent: текст журнала не исполняется
      body.append(card);
    }
    if (atBottom) body.scrollTop = body.scrollHeight;
  }
  async function tick() {
    try {
      const r = await fetch("/om_design/feed", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      if (!d.ok) { state.textContent = d.code === "channel_missing" ? "журнал не найден" : "журнал не читается"; return; }
      const sig = d.total + ":" + (d.items.length ? d.items[d.items.length - 1].n : 0);
      if (sig !== lastSig) { lastSig = sig; render(d.items); }
      lastTotal = d.total; state.textContent = d.broken ? `записей ${d.total}, битых строк ${d.broken}` : `записей ${d.total}`;
      if (collapsed && d.total > seen) { badge.textContent = "+" + (d.total - seen); badge.style.display = "inline"; } else apply();
    } catch (e) { state.textContent = "нет связи с лентой"; }
  }
  const start = () => { document.body.append(box); apply(); tick(); setInterval(tick, POLL_MS); };
  if (document.body) start(); else window.addEventListener("DOMContentLoaded", start);
})();
