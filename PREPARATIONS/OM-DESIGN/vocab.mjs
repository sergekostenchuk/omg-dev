// Общий словарь: тип узла схемы -> класс ComfyUI, поля, выходы. Должен совпадать с comfy/om_design/__init__.py.
export const TYPES = {
  goal:      { cls: "OMD_Goal",      fields: ["цель", "критерии успеха", "критерий провала"], outputs: ["дальше"], size: [380, 300], color: "#22303f" },
  stage:     { cls: "OMD_Stage",     fields: ["стадия", "цель стадии", "выходы сейчас", "изменения под OM", "ворота стадии"], outputs: ["выход", "дальше"], size: [380, 420], color: "#2a2d33" },
  input:     { cls: "OMD_Input",     fields: ["артефакт", "что содержит сейчас", "что нужно OM", "дообогащение"], outputs: ["запись"], size: [380, 340], color: "#2a2d33" },
  mechanism: { cls: "OMD_Mechanism", fields: ["название", "цель", "что делает", "вход", "выход", "ворота"], outputs: ["запись", "дальше"], size: [380, 440], color: "#23302b" },
  model:     { cls: "OMD_Model",     fields: ["название", "вопрос", "почему невыводимо", "вид источника", "потребитель", "передача и бюджет"], outputs: ["ответ", "дальше"], size: [380, 440], color: "#3a3220" },
  gate:      { cls: "OMD_Gate",      fields: ["название", "что проверяет", "коды отказа"], outputs: ["пройдено", "отказ"], size: [380, 280], color: "#3a2222" },
  owner:     { cls: "OMD_Owner",     fields: ["вопрос", "варианты", "решение", "статус"], outputs: ["дальше"], size: [380, 340], color: "#22303f" },
  store:     { cls: "OMD_Store",     fields: ["запись", "что хранит"], outputs: ["запись"], size: [340, 200], color: "#2a2d33" },
  output:    { cls: "OMD_Output",    fields: ["артефакт", "критерии"], outputs: ["к потребителю"], size: [380, 300], color: "#1f3a2a" },
};
export const CLS_TO_TYPE = Object.fromEntries(Object.entries(TYPES).map(([t, v]) => [v.cls, t]));
export const EDGE_KINDS = { record: "RECORD", flow: "FLOW", gate_pass: "FLOW", gate_fail: "FLOW" };
