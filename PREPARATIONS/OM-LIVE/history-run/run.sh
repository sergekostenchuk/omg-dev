#!/bin/bash
# «Прогон истории» — проверка черновика движка на КОПИИ живой базы, без модели и без git.
#   RUN=<папка со сборкой dist> OUT=<папка результата> [DURATION_MIN=20] [SRC=<готовая копия .sqlite>] run.sh
# Движок продолжает проход omg-live на копии; заглушка вместо модели отказывает (вызов отмечается), предохранитель git — тоже.
# Профиль процессора снимается непрерывно окнами по 30 с. Итог в $OUT/report.txt:
#   время от старта до каждого вызова модели, промежутки между ними, число записанных событий, сводка профиля.
# Мерило черновика: до первого вызова — секунды или минута, между вызовами — секунды; в профиле нет повторных выводов истории.
set -u; H=$(cd "$(dirname "$0")" && pwd); RUN=${RUN:?сборка}; OUT=${OUT:?папка результата}; DUR=${DURATION_MIN:-20}; NODE=$(command -v node)
mkdir -p "$OUT"; rm -rf "$OUT"/copy.sqlite* "$OUT/prof" "$OUT"/*.log "$OUT"/*.jsonl "$OUT"/*.out "$OUT"/*.err "$OUT/report.txt"; mkdir -p "$OUT/prof"
export HISTORY_RUN_OUT="$OUT"
if [ -n "${SRC:-}" ]; then cp "$SRC" "$OUT/copy.sqlite" && chmod u+w "$OUT/copy.sqlite"; else sqlite3 "file:$HOME/OMG/.omg/state.sqlite?mode=ro&immutable=1" ".backup $OUT/copy.sqlite" || { echo "STOP: копия"; exit 1; }; fi
cmd() { "$NODE" "$RUN/dist/src/cli.js" command "$OUT/copy.sqlite"; }
STATE=$(printf '%s' '{"type":"om-state","project":"omg-live"}' | cmd 2>/dev/null)
TOK=$(jq -r '.value.control.control.value.stop.token // empty' <<<"$STATE")
[ -n "$TOK" ] || { echo "STOP: на копии нет стоящего стопа (проход должен быть остановлен): $(head -c 300 <<<"$STATE")"; exit 1; }
printf '%s' "{\"type\":\"om-continue\",\"project\":\"omg-live\",\"resumeStop\":\"$TOK\"}" > "$OUT/input.json"
START=$(date +%s); echo "старт $(date +%H:%M:%S); сборка $(git -C "$RUN" rev-parse --short HEAD 2>/dev/null) $RUN; копия $(du -h "$OUT/copy.sqlite" | cut -f1)" | tee "$OUT/report.txt"
PATH="$H/bin:$PATH" "$NODE" "$RUN/dist/src/cli.js" command "$OUT/copy.sqlite" < "$OUT/input.json" > "$OUT/continue.out" 2> "$OUT/continue.err" &
P=$!
"$NODE" "$H/../stall-watch.mjs" --pid $P --db "$OUT/copy.sqlite" --always --sample 30 --log "$OUT/profile.jsonl" --profiles "$OUT/prof" > /dev/null 2>&1 &
W=$!
LAST=$(sqlite3 "file:$OUT/copy.sqlite?mode=ro&immutable=1" "select max(sequence) from events"); FIRST=$LAST
while kill -0 $P 2>/dev/null && [ $(( $(date +%s) - START )) -lt $(( DUR * 60 )) ]; do
  sleep 10
  NEW=$(sqlite3 "file:$OUT/copy.sqlite?mode=ro" "select sequence||' '||entity_id||' r'||revision from events where sequence > $LAST order by sequence" 2>/dev/null)
  if [ -n "$NEW" ]; then echo "$NEW" | sed "s/^/+$(( $(date +%s) - START ))с /" >> "$OUT/events.log"; LAST=$(echo "$NEW" | tail -1 | cut -d' ' -f1); fi
done
kill $W 2>/dev/null
if kill -0 $P 2>/dev/null; then printf '%s' '{"type":"om-stop","project":"omg-live"}' | cmd > /dev/null 2>&1; sleep 20; kill $P 2>/dev/null; fi
{
  echo "наблюдение $(( $(date +%s) - START )) с; событий записано $(( LAST - FIRST ))"
  echo "вызовы модели (заглушка), секунд от старта:"
  PREV=$START; grep -v -- "--version" "$OUT/stub-calls.log" 2>/dev/null | while read -r e t rest; do echo "  $t: +$(( e - START )) с от старта, +$(( e - PREV )) с от предыдущего"; PREV=$e; done
  echo "git: $(wc -l < "$OUT/git-calls.log" 2>/dev/null || echo 0) вызовов"
  echo; node "$H/../profile-summary.mjs" "$OUT/prof" --top 30
} >> "$OUT/report.txt"
cat "$OUT/report.txt" | head -60
