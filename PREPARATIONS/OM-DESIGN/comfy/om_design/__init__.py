# Словарь узлов проектной схемы блока OM для ComfyUI. Узлы ничего не вычисляют: они держат текст схемы и связи.
# Источник истины схемы: PREPARATIONS/OM-DESIGN/om-design.json (получается импортом из воркфлоу).
class AnyType(str):
    def __ne__(self, other): return False
ANY = AnyType("*")
N_IN = 8

def _inputs(fields):
    req = {name: ("STRING", {"multiline": multi, "default": ""}) for name, multi in fields}
    opt = {f"in_{i}": (ANY, {}) for i in range(1, N_IN + 1)}
    return {"required": req, "optional": opt}

def _node(cls_name, display, fields, outputs, output_names, output_node=False):
    def INPUT_TYPES(s): return _inputs(fields)
    def run(self, **kw): return tuple(kw.get(fields[0][0], "") for _ in outputs) if outputs else {}
    attrs = {"INPUT_TYPES": classmethod(INPUT_TYPES), "RETURN_TYPES": tuple(outputs), "RETURN_NAMES": tuple(output_names),
             "FUNCTION": "run", "CATEGORY": "OM/схема", "run": run, "DISPLAY": display, "FIELDS": [f for f, _ in fields]}
    if output_node: attrs["OUTPUT_NODE"] = True
    return type(cls_name, (), attrs)

# type в om-design.json -> класс
SPEC = {
  "goal":      ("OMD_Goal",      "OM · Цель блока",              [("цель", True), ("критерии успеха", True), ("критерий провала", True)], ["FLOW"], ["дальше"]),
  "stage":     ("OMD_Stage",     "OM · Стадия-предшественник",   [("стадия", False), ("цель стадии", True), ("выходы сейчас", True), ("изменения под OM", True), ("ворота стадии", True)], ["RECORD", "FLOW"], ["выход", "дальше"]),
  "input":     ("OMD_Input",     "OM · Вход от предшественника", [("артефакт", False), ("что содержит сейчас", True), ("что нужно OM", True), ("дообогащение", True)], ["RECORD"], ["запись"]),
  "mechanism": ("OMD_Mechanism", "OM · Механизм (код)",          [("название", False), ("цель", True), ("что делает", True), ("вход", True), ("выход", True), ("ворота", True)], ["RECORD", "FLOW"], ["запись", "дальше"]),
  "model":     ("OMD_Model",     "OM · Вызов модели",            [("название", False), ("вопрос", True), ("почему невыводимо", True), ("вид источника", False), ("потребитель", False), ("передача и бюджет", True)], ["RECORD", "FLOW"], ["ответ", "дальше"]),
  "gate":      ("OMD_Gate",      "OM · Ворота",                  [("название", False), ("что проверяет", True), ("коды отказа", True)], ["FLOW", "FLOW"], ["пройдено", "отказ"]),
  "owner":     ("OMD_Owner",     "OM · Решение владельца",       [("вопрос", True), ("варианты", True), ("решение", True), ("статус", False)], ["FLOW"], ["дальше"]),
  "store":     ("OMD_Store",     "OM · Запись хранилища",        [("запись", False), ("что хранит", True)], ["RECORD"], ["запись"]),
  "output":    ("OMD_Output",    "OM · Выход к компилятору",     [("артефакт", False), ("критерии", True)], ["FLOW"], ["к потребителю"]),
}
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
for key, (cls_name, display, fields, outs, names) in SPEC.items():
    cls = _node(cls_name, display, fields, outs, names, output_node=(key == "output"))
    NODE_CLASS_MAPPINGS[cls_name] = cls
    NODE_DISPLAY_NAME_MAPPINGS[cls_name] = display
