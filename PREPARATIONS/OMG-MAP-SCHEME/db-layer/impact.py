#!/usr/bin/env python3
"""Список задетых по слою «База»: какие записи меняет задача, кто их читает и какие тесты покрывают читателей.

Источник — db-layer.json (виды записей, писатели и читатели с узлами схемы и местами кода).
Записи задачи определяются по путям задачи (виды, у которых есть писатель в этих файлах)
и/или явно по --kinds. Для каждого вида печатаются читатели вне путей задачи, их места кода
и тестовые файлы, которые импортируют модули этих читателей.

Запуск:
  python3 impact.py --paths src/om/input.ts src/discovery/requirements.ts
  python3 impact.py --kinds stage question --repo ~/omg-wt/omg-ds2-final
Вывод — Markdown для пакета задачи. Ничего не пишет.
"""
import argparse
import json
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_REPO = Path.home() / "omg-wt" / "omg-ds2-final"


def code_files(entry):
    return {m.group(1) for m in re.finditer(r"(src/[\w./-]+\.ts)", entry.get("code") or "")}


def node_title(nodes, key):
    parts, cur, out = key.split("."), "", []
    for p in parts:
        cur = f"{cur}.{p}" if cur else p
        if cur in nodes:
            out.append(nodes[cur]["t"])
    return " · ".join(out) or key


def tests_for(repo, src_files):
    """Тестовые файлы, импортирующие хотя бы один из модулей (по имени файла без расширения)."""
    if not src_files:
        return {}
    test_dir = repo / "test"
    if not test_dir.is_dir():
        return {}
    found = {}
    for f in sorted(src_files):
        stem = f[len("src/"):-len(".ts")]
        pattern = rf"(src/{re.escape(stem)}(\.js|\.ts)?['\"])"
        try:
            out = subprocess.run(["grep", "-rlE", pattern, str(test_dir)], capture_output=True, text=True, timeout=30).stdout
        except subprocess.TimeoutExpired:
            out = ""
        for t in out.split():
            found.setdefault(str(Path(t).relative_to(repo)), set()).add(f)
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--paths", nargs="*", default=[], help="пути задачи (src/… и test/…)")
    ap.add_argument("--kinds", nargs="*", default=[], help="виды записей явно")
    ap.add_argument("--repo", default=str(DEFAULT_REPO), help="рабочее дерево движка для поиска тестов")
    a = ap.parse_args()
    layer = json.loads((HERE / "db-layer.json").read_text())
    nodes = {n["key"]: n for n in json.loads((HERE / "map-nodes.json").read_text())}
    paths = {p for p in a.paths if p.startswith("src/")}
    kinds = {k["kind"]: k for k in layer["kinds"]}

    touched = {}
    for k in layer["kinds"]:
        hits = [w for w in k.get("writers") or [] if code_files(w) & paths]
        if hits:
            touched[k["kind"]] = "пишет код задачи: " + ", ".join(sorted({f for w in hits for f in code_files(w) & paths}))
    for name in a.kinds:
        if name in kinds:
            touched.setdefault(name, "указан явно")
        else:
            touched.setdefault(name, "нет в слое «База»")

    print("## Задетые записи и читатели (слой «База»)\n")
    if not touched:
        print("Задача не пишет записей, описанных в слое «База» (по путям задачи). Если это неверно — укажи виды явно.\n")
        return
    reader_files = set()
    unsure = 0
    for name in sorted(touched):
        k = kinds.get(name)
        print(f"### `{name}` — {touched[name]}")
        if not k:
            print("Вида нет в слое: описать читателей вручную.\n")
            continue
        readers = [r for r in k.get("readers") or [] if not (code_files(r) <= paths and code_files(r))]
        if not readers:
            print("Читателей вне путей задачи нет.\n")
            continue
        print("| Читатель (узел схемы) | Место кода | Поля | Ожидает | Проверено |")
        print("|---|---|---|---|---|")
        for r in readers:
            reader_files |= code_files(r)
            sure = "нет" if r.get("sure") is False else "да"
            unsure += r.get("sure") is False
            fields = ", ".join(r.get("fields") or [])[:80]
            expects = (r.get("expects") or "").replace("|", "/")[:140]
            print(f"| {node_title(nodes, r['node'])} (`{r['node']}`) | {r.get('code', '')} | {fields} | {expects} | {sure} |")
        print()
    tests = tests_for(Path(a.repo).expanduser(), reader_files - paths)
    print("### Тесты, покрывающие читателей\n")
    if tests:
        for t, files in sorted(tests.items()):
            print(f"- `{t}` — импортирует {', '.join(sorted(files))}")
    else:
        print("Тестов, импортирующих модули читателей, не найдено — проверить вручную.")
    print(f"\nСвязей «не проверено» среди читателей: {unsure}. Список — подсказка для прохода «СОСЕДИ», не доказательство; групповой полный прогон обязателен.\n")


if __name__ == "__main__":
    main()
