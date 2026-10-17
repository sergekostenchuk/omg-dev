#!/usr/bin/env python3
"""Сливает частичный файл стадии (db-layer-<stage>.json) в общий слой db-layer.json.

Новые виды добавляются целиком; для уже описанных видов дописываются связи
писателей и читателей из блока "extend" (одна связь на пару «вид, узел»,
поля объединяются). Группы стадии встают перед группой предложений New Discovery.
Проверяет, что каждый узел есть в map-nodes.json.

Запуск: python3 merge_partial.py db-layer-map.json
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LAYER = HERE / "db-layer.json"
NODES = {n["key"] for n in json.loads((HERE / "map-nodes.json").read_text())}


def merge_links(dst, src):
    by_node = {e["node"]: e for e in dst}
    for e in src:
        old = by_node.get(e["node"])
        if old is None:
            dst.append(e)
            by_node[e["node"]] = e
            continue
        old["fields"] = sorted(set(old.get("fields") or []) | set(e.get("fields") or []))
        codes = [c.strip() for c in (old.get("code") or "").split(";") if c.strip()]
        for c in (e.get("code") or "").split(";"):
            if c.strip() and c.strip() not in codes:
                codes.append(c.strip())
        old["code"] = "; ".join(codes[:3])
        if e.get("sure") is False:
            old["sure"] = old.get("sure", True) and False


def main(name):
    layer = json.loads(LAYER.read_text())
    part = json.loads((HERE / name).read_text())
    bad = []
    for k in part.get("kinds", []) + part.get("extend", []):
        for e in (k.get("writers") or []) + (k.get("readers") or []):
            if e["node"] not in NODES:
                bad.append((k["kind"], e["node"]))
    if bad:
        sys.exit(f"узлов нет на схеме: {bad[:10]} … всего {len(bad)}")
    groups = [g["id"] for g in layer["groups"]]
    for g in part.get("groups", []):
        if not any(k.get("group") == g["id"] for k in part.get("kinds", [])):
            continue  # стадия без своих видов: пустую группу не заводим
        if g["id"] not in groups:
            at = groups.index("ndisc") if "ndisc" in groups else len(groups)
            layer["groups"].insert(at, g)
            groups.insert(at, g["id"])
    known = {k["kind"]: k for k in layer["kinds"]}
    added = 0
    for k in part.get("kinds", []):
        if k["kind"] in known:
            merge_links(known[k["kind"]].setdefault("writers", []), k.get("writers") or [])
            merge_links(known[k["kind"]].setdefault("readers", []), k.get("readers") or [])
        else:
            layer["kinds"].append(k)
            known[k["kind"]] = k
            added += 1
    ext = 0
    # связи к видам, которых ещё нет: ждут в "pending" и подключаются, когда вид появится
    pending = layer.setdefault("pending", [])
    still = []
    for e in pending + part.get("extend", []):
        k = known.get(e["kind"])
        if k is None:
            still.append(e)
            continue
        merge_links(k.setdefault("writers", []), e.get("writers") or [])
        merge_links(k.setdefault("readers", []), e.get("readers") or [])
        ext += len(e.get("writers") or []) + len(e.get("readers") or [])
    layer["pending"] = still
    if still:
        print("ждут вида:", sorted({e["kind"] for e in still}))
    layer["version"] = layer.get("version", "") + "+" + part.get("version", name)
    LAYER.write_text(json.dumps(layer, ensure_ascii=False, indent=0))
    print(f"новых видов {added}, добавочных связей {ext}, всего видов {len(layer['kinds'])}")


if __name__ == "__main__":
    main(sys.argv[1])
