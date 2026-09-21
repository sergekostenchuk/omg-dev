# Словарь узлов проектной схемы блока OM для ComfyUI. Узлы ничего не вычисляют: они держат текст схемы и связи.
# Источник истины схемы: PREPARATIONS/OM-DESIGN/om-design.json (получается импортом из воркфлоу).
class AnyType(str):
    def __ne__(self, other): return False
ANY = AnyType("*")
def _inputs(fields, n_in):
    req = {name: ("STRING", {"multiline": multi, "default": ""}) for name, multi in fields}
    opt = {f"in_{i}": (ANY, {}) for i in range(1, n_in + 1)}
    return {"required": req, "optional": opt}

def _node(cls_name, display, fields, outputs, output_names, n_in, output_node=False):
    def INPUT_TYPES(s): return _inputs(fields, n_in)
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
  "model":     ("OMD_Model",     "OM · Вызов модели",            [("название", False), ("вопрос", True), ("почему невыводимо", True), ("вид источника", False), ("потребитель", False), ("очередь и учёт", True)], ["RECORD", "FLOW"], ["ответ", "дальше"]),
  "gate":      ("OMD_Gate",      "OM · Ворота",                  [("название", False), ("что проверяет", True), ("коды отказа", True)], ["FLOW", "FLOW"], ["пройдено", "отказ"]),
  "owner":     ("OMD_Owner",     "OM · Решение владельца",       [("вопрос", True), ("варианты", True), ("решение", True), ("статус", False)], ["FLOW"], ["дальше"]),
  "store":     ("OMD_Store",     "OM · Запись хранилища",        [("запись", False), ("что хранит", True)], ["RECORD"], ["запись"]),
  "output":    ("OMD_Output",    "OM · Выход к компилятору",     [("артефакт", False), ("критерии", True)], ["FLOW"], ["к потребителю"]),
}
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
N_IN = {"goal": 8, "stage": 3, "input": 2, "mechanism": 6, "model": 4, "gate": 3, "owner": 1, "store": 8, "output": 2}
for key, (cls_name, display, fields, outs, names) in SPEC.items():
    cls = _node(cls_name, display, fields, outs, names, N_IN[key], output_node=(key == "output"))
    NODE_CLASS_MAPPINGS[cls_name] = cls
    NODE_DISPLAY_NAME_MAPPINGS[cls_name] = display


# ---- Лента ревью на странице ComfyUI: проекция журнала ~/.asvp-review/channel.ndjson, только чтение ----
# Запросы Claude Code и вердикты Codex по темам OMG-* пишутся в журнал один раз; страница читает его сама.
# Никто ничего не дублирует руками, модель для пересказа не нужна, карта (воркфлоу) при этом не меняется.
import json as _json, os as _os

FEED_PREFIX = "OMG-"
FEED_LIMIT = 300


def read_feed(path, prefix=FEED_PREFIX, limit=FEED_LIMIT):
    """-> {"ok", "items", ...}. Нет журнала — типизированный отказ, а не пустая лента; битая строка не роняет остальные."""
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read()
    except FileNotFoundError:
        return {"ok": False, "code": "channel_missing", "path": path}
    except OSError as e:
        return {"ok": False, "code": "channel_unreadable", "path": path, "message": str(e)[:200]}
    items, broken = [], 0
    for n, line in enumerate(raw.split("\n")[: raw.count("\n")], start=1):      # только завершённые строки
        if not line.strip():
            continue
        try:
            d = _json.loads(line)
        except Exception:
            broken += 1
            continue
        if not isinstance(d, dict) or not str(d.get("topic", "")).startswith(prefix):
            continue
        items.append({"n": n, "ts": str(d.get("ts", ""))[:19], "from": str(d.get("from", "")), "to": str(d.get("to", "")),
                      "kind": str(d.get("kind", "")), "topic": str(d.get("topic", "")), "text": str(d.get("text", ""))[:40000]})
    return {"ok": True, "items": items[-limit:], "total": len(items), "broken": broken}


try:
    from aiohttp import web as _web
    from server import PromptServer as _PS

    @_PS.instance.routes.get("/om_design/feed")
    async def _om_feed(request):
        home = _os.environ.get("ASVP_REVIEW_HOME") or _os.path.expanduser("~/.asvp-review")
        return _web.json_response(read_feed(_os.path.join(home, "channel.ndjson")), headers={"Cache-Control": "no-store"})
except Exception as _e:                      # вне ComfyUI (проверки, импорт скриптами) — словарь узлов работает без ленты
    print("[om_design] лента ревью не подключена:", _e)

WEB_DIRECTORY = "./web"
