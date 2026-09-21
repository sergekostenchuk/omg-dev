import { useState } from "react";
import type { ProductEngine } from "../src/product/engine.js";

const labels: Record<string, string> = { implementing: "Исполнитель работает", checking: "Полный прогон", reviewing: "Независимое ревью",
  commit_pending: "Коммит ожидает регистрации", committed: "Закоммичено", needs_code: "Нужна коррекция кода", needs_plan: "Нужна коррекция карты", interrupted: "Прервано" };
export function ExecutionPanel({ view, command, refresh }: {
  view: ReturnType<ProductEngine['projection']>; command: (value: unknown) => Promise<unknown>; refresh: () => Promise<void>;
}) {
  const [waiting, setWaiting] = useState(false); const [error, setError] = useState("");
  const plan = view.currentPlan?.value;
  const runs = view.runs.filter(run => run.value.plan.id === plan?.id);
  const active = waiting || view.executionRunning;
  const execute = async () => {
    if (!plan) return;
    setWaiting(true); setError(""); const timer = setInterval(() => { void refresh().catch(() => {}); }, 1200);
    try { await command({ type: "execute-plan", project: view.project.value.id, plan, retry: true }); }
    catch (error) { setError(error instanceof Error ? error.message : "Запуск не завершён"); }
    finally { clearInterval(timer); setWaiting(false); await refresh(); }
  };
  return <div><p className="muted">Движок выполняет текущий горизонт в отдельной ветке. Каждая задача проходит полный прогон и независимое ревью, затем получает один коммит.</p>
    {view.executionRoot && <p>Рабочая папка: <code>{view.executionRoot.value.path}</code><br/>Ветка: <code>{view.executionRoot.value.branch}</code></p>}
    <div className="action-row"><button disabled={active || !plan || runs.some(run => run.value.state === "needs_plan")}
      onClick={() => { void execute(); }}>{runs.length ? "Продолжить или восстановить выполнение" : "Выполнить горизонт"}</button>
      {active && <button className="secondary" onClick={() => { void command({ type: "stop-execution", project: view.project.value.id }).then(refresh).catch(error => setError(error.message)); }}>Остановить</button>}</div>
    {error && <p role="alert" className="findings">{error}</p>}
    {!plan && <p className="empty-inline">Сначала скомпилируйте машинный план.</p>}
    {runs.map(run => <article className="question" key={run.id}><span className="eyebrow">ПОПЫТКА {run.value.attempt}</span>
      <h3>{view.plans.find(plan => plan.id === run.value.plan.id)?.value.tasks.find(task => task.id === run.value.taskId)?.title ?? run.value.taskId}</h3>
      <strong>{labels[run.value.state]}</strong>{run.value.error && <p role="alert">{run.value.error}</p>}
      {run.value.state === "needs_plan" && <p>Пересмотрите соответствующий узел карты и его требования. Повтор этой задачи по прежнему плану закрыт.</p>}
      {run.value.commit && <p>Коммит: <code>{run.value.commit}</code></p>}
      <details><summary>Результат и доказательства</summary><pre>{JSON.stringify({ artifacts: run.value.artifacts,
        checks: run.value.checks, review: run.value.review }, null, 2)}</pre></details>
    </article>)}
  </div>;
}
