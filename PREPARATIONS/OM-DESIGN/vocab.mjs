// Общий словарь: тип узла схемы -> класс ComfyUI, поля, выходы. Должен совпадать с comfy/om_design/__init__.py.
export const TYPES = {
  goal:      { cls: "OMD_Goal", nIn: 8,      fields: ["цель", "критерии успеха", "критерий провала"], outputs: ["дальше"], size: [380, 336], color: "#22303f" },
  stage:     { cls: "OMD_Stage", nIn: 3,     fields: ["стадия", "цель стадии", "выходы сейчас", "изменения под OM", "ворота стадии"], outputs: ["выход", "дальше"], size: [380, 420], color: "#2a2d33" },
  input:     { cls: "OMD_Input", nIn: 2,     fields: ["артефакт", "что содержит сейчас", "что нужно OM", "дообогащение"], outputs: ["запись"], size: [380, 340], color: "#2a2d33" },
  mechanism: { cls: "OMD_Mechanism", nIn: 6, fields: ["название", "цель", "что делает", "вход", "выход", "ворота"], outputs: ["запись", "дальше"], size: [380, 440], color: "#23302b" },
  model:     { cls: "OMD_Model", nIn: 4,     fields: ["название", "вопрос", "почему невыводимо", "вид источника", "потребитель", "очередь и учёт"], outputs: ["ответ", "дальше"], size: [380, 440], color: "#3a3220" },
  gate:      { cls: "OMD_Gate", nIn: 3,      fields: ["название", "что проверяет", "коды отказа"], outputs: ["пройдено", "отказ"], size: [380, 280], color: "#3a2222" },
  owner:     { cls: "OMD_Owner", nIn: 1,     fields: ["вопрос", "варианты", "решение", "статус"], outputs: ["дальше"], size: [380, 360], color: "#22303f" },
  store:     { cls: "OMD_Store", nIn: 8,     fields: ["запись", "что хранит"], outputs: ["запись"], size: [340, 200], color: "#2a2d33" },
  output:    { cls: "OMD_Output", nIn: 2,    fields: ["артефакт", "критерии"], outputs: ["к потребителю"], size: [380, 300], color: "#1f3a2a" },
};
export const CLS_TO_TYPE = Object.fromEntries(Object.entries(TYPES).map(([t, v]) => [v.cls, t]));
export const EDGE_KINDS = { record: "RECORD", flow: "FLOW", gate_pass: "FLOW", gate_fail: "FLOW" };

// Высота карточки от текста: ComfyUI делит свободную высоту поровну между многострочными полями.
export const W = 620, CPL = 82, LINE = 17;
export function heightOf(type, fields) { const T = TYPES[type]; let h = 40 + T.nIn * 20 + 24; let multi = 0, need = 0;
  for (const f of T.fields) { const text = String(fields?.[f] ?? ""); const isMulti = text.length > 60 || text.includes("\n");
    if (!isMulti) { h += 30; continue; } multi++; const lines = text.split("\n").reduce((s, p) => s + Math.max(1, Math.ceil(p.length / CPL)), 0); need = Math.max(need, lines * LINE + 30); }
  return Math.max(T.size[1], Math.round(h + multi * Math.max(need, 60))); }
