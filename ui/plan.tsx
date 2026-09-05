import type { ProductEngine } from "../src/product/engine.js";

export function PlanPanel({ view, compile, busy }: {
  view: ReturnType<ProductEngine['projection']>; compile: () => void; busy: boolean;
}) {
  const plan = view.plans.find(item => item.id === view.currentPlan?.value.id);
  const ready = view.stages.find(item => item.stage === "om-g2")?.state === "accepted";
  return <div>
    <p className="muted">Задачи, зависимости, области изменений и проверки выводятся из принятой карты текущего горизонта.</p>
    <button disabled={busy || !ready} onClick={compile}>Скомпилировать машинный план</button>
    {!ready && <p className="muted">Сначала завершите R3 и примите результат OM-G2.</p>}
    {view.planGate?.findings.length ? <div className="findings">{view.planGate.findings.map((item, index) => <p key={index}>{item.message} · {item.target}</p>)}</div> : null}
    {plan ? <div className="research-group"><h3>Задач в горизонте: {plan.value.tasks.length}</h3>
      {plan.value.tasks.map((task, index) => <article className="question" key={task.id}>
        <span className="eyebrow">ЗАДАЧА {index + 1} · ИЗ УЗЛА {task.node}</span><h3>{task.title}</h3>
        <p>Результат: {task.outcome}</p>
        <p>Предшественники: {task.dependencies.map(id => plan.value.tasks.find(item => item.id === id)?.title ?? id).join(", ") || "Нет"}</p>
        <p>Изменяемые файлы: {task.writePaths.join(", ")}</p>
        <details><summary>Входы и обязательства проверки</summary><pre>{JSON.stringify({ inputs: task.inputs,
          tests: task.tests, obligations: task.obligations, recovery: task.boundary.rollback }, null, 2)}</pre></details>
      </article>)}
    </div> : <p className="empty-inline">Машинный план ещё не скомпилирован.</p>}
  </div>;
}
