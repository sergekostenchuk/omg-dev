// Тестовый граф для M7: штатная фикстура движка «garden» (test/graph-fixture.ts + test/enriched-graph-fixture.ts), расширенная так,
// чтобы были видны связи ПОДБЛОК ↔ ПОДБЛОК: у блока produce два подблока (prep → produce, локальная связь), сосед в другом блоке (consume)
// и сосед вне горизонта (later). Граф проходит настоящий validateGraph.
import { exampleGraph } from "../../../dist/test/graph-fixture.js";
import { enrichedGraph } from "../../../dist/test/enriched-graph-fixture.js";

export function gardenPlus({ alt = false } = {}) {
  const g = exampleGraph("garden"); const boundary = g.nodes[0].boundary; const K = "garden-contract"; const port = (id, direction) => ({ id, direction, contract: K });
  const node = (id, kind, parent, outcome, ports, work = false) => ({ id, kind, parent, title: id, outcome, boundary, ports, code: work ? [{ path: `${id}.txt`, access: "write", status: "planned" }] : [], tests: work ? [`${id}-test`] : [] });
  g.artifacts.push({ id: "garden-prep", contract: K, external: false, terminal: false }, { id: "garden-later", contract: K, external: false, terminal: true });
  g.nodes.push(node("garden-prep-operation", "operation", "garden-produce-block", "garden-prep", [port("out", "out")]), node("garden-prep-work", "work", "garden-prep-operation", "garden-prep", [port("out", "out")], true),
    node("garden-later-block", "block", "garden-product", "garden-later", [port("in", "in")]), node("garden-later-operation", "operation", "garden-later-block", "garden-later", [port("in", "in")]));
  for (const id of ["garden-produce-operation", "garden-produce-work"]) g.nodes.find(n => n.id === id).ports.push(port("in", "in"));
  g.connectors.push({ id: "garden-prep-flow", artifact: "garden-prep", returnsTo: "garden-produce-block", wakeTest: null, bindings: [
    { level: 2, producer: { node: "garden-prep-operation", port: "out" }, consumers: [{ node: "garden-produce-operation", port: "in" }], anchor: null },
    { level: 3, producer: { node: "garden-prep-work", port: "out" }, consumers: [{ node: "garden-produce-work", port: "in" }], anchor: null }] });
  const flow = g.connectors.find(c => c.id === "garden-flow"); flow.bindings.find(b => b.level === 1).consumers.push({ node: "garden-later-block", port: "in" }); flow.bindings.find(b => b.level === 2).consumers.push({ node: "garden-later-operation", port: "in" });
  // alt: у ОДНОЙ связи два потока с разными портами (out → in и out-alt → in-alt) на всех трёх уровнях — контрпример ревью к вердикту №1 по M7
  if (alt) for (const kind of ["block", "operation", "work"]) { g.nodes.find(n => n.id === `garden-produce-${kind}`).ports.push(port("out-alt", "out")); g.nodes.find(n => n.id === `garden-consume-${kind}`).ports.push(port("in-alt", "in"));
    // alt = "cross": второй поток питает ТОТ ЖЕ порт потребителя, а первый — два порта одного узла: концы различимы только потоком и портом вместе
    if (alt === "cross") flow.bindings.find(b => b.level === { block: 1, operation: 2, work: 3 }[kind]).consumers.push({ node: `garden-consume-${kind}`, port: "in-alt" });
    flow.bindings.push({ level: { block: 1, operation: 2, work: 3 }[kind], producer: { node: `garden-produce-${kind}`, port: "out-alt" }, consumers: [{ node: `garden-consume-${kind}`, port: alt === "cross" ? "in" : "in-alt" }], anchor: null }); }
  g.tests.push({ id: "garden-prep-work-test", node: "garden-prep-work", command: { executable: "node", args: ["--version"] }, covers: ["garden-prep-flow"] });
  g.horizon.push("garden-prep-work");
  const v2 = enrichedGraph(g, "garden");      // конечный результат обязан наблюдаться в пути пользователя (terminal_outcome_unobserved)
  v2.journeys.push({ ...structuredClone(v2.journeys.find(j => j.terminal === "success")), id: "garden-journey-later", path: ["garden-produce-block", "garden-later-block"], outcome: "garden-later" });
  return v2;
}
