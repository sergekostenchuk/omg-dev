import { relative, isAbsolute } from "node:path";
import { requireCondition } from "../errors.js";
import type { Ref } from "../pipeline/contracts.js";

const rows = (v: any): any[] => Array.isArray(v) ? v : v?.rows?.map((r: unknown[]) => Object.fromEntries(v.columns.map((k: string, i: number) => [k, r[i]]))) ?? [];
const pointer = (s: string) => s.replaceAll("~", "~0").replaceAll("/", "~1");

/** Exact statements, structural identifiers and addresses; never a generated
 * summary of code or evidence. Synthesis still receives the full working view. */
export function planningContext(body: Record<string, any>, archive: Ref, maxChars: number) {
  const root = body.repositoryRoot as string;
  requireCondition(typeof root === "string" && isAbsolute(root), "planning_context_invalid", "Planning requires its bound repository root");
  const sourceLocations = new Map((body.inventory?.sources ?? []).map((s: any) => [s.ref.id, s.location]));
  const location = (s: string) => {
    const path = relative(root, s);
    return path && !path.startsWith("..") && !isAbsolute(path) ? path : s;
  };
  const packet = {
    role: body.role, dispatchMode: "planning", stage: body.stage, level: body.level, consumer: body.consumer,
    draft: body.draft, question: { id: body.question.id, field: body.question.field, kind: body.question.kind,
      prompt: body.question.prompt, risk: body.question.risk },
    objective: body.core.objective, problem: body.core.problem, actors: body.core.actors,
    constraints: body.core.constraints, specificationConstraints: body.core.specificationConstraints,
    concept: body.core.concept,
    requirements: rows(body.core.requirements).flatMap((s: any, si: number) => rows(s.requirements).map((r: any, ri: number) => ({
      id: r.id, statement: r.statement, outcome: r.outcome, beneficiary: r.beneficiary,
      pointer: `/content/fields/conceptSections/${si}/requirements/${ri}` }))),
    nodes: rows(body.map.nodes).map((n: any) => ({ id: n.id, title: n.title, parent: n.parent, outcome: n.outcome, pointer: n.pointer })),
    map: { ref: body.map.ref, graphBase: body.graphBase },
    files: body.inventory.files, filesTruncated: body.inventory.filesTruncated,
    sources: body.inventory.sources.map((s: any, index: number) => ({ index, location: location(s.location), media: s.media, chars: s.length,
      ...(s.kind !== "file" || isAbsolute(location(s.location)) ? { ref: s.ref } : {}) })),
    records: body.catalogue.map((r: any) => ({ ref: r.ref, kind: r.kind, stage: r.stage,
      fields: r.fields.map((f: any) => ({ field: f.field, pointer: f.pointer, chars: f.chars })) })),
    alreadyRead: body.readings.map((r: any, i: number) => ({ pointer: `/body/readings/${i}`, purposePointer: `/body/readings/${i}/purpose`,
      sources: r.coverage.map((c: any) => ({ location: location(String(sourceLocations.get(c.ref.id) ?? c.ref.id)), range: c.visibleRange })),
      unresolvedCount: r.unresolved.length, unresolvedPointer: `/body/readings/${i}/unresolved` })),
    priorReads: body.directReadings.map((r: any, i: number) => ({ pointer: `/body/directReadings/${i}`, action: r.action })),
    answers: body.answers, missing: body.researchMissing ?? [], readPlanStatus: body.readPlanStatus,
    openGaps: body.openGaps, failures: body.failures, unresolvedEvidence: body.unresolvedEvidence,
    working: { archive, instruction: "This is a navigation index, not evidence or an answer context. Every requirement/node is indexed. Full criteria, schemas, evidence, checkpoints and histories remain in the archived body. Use its record and /body/... pointers. Original source refs are returned with reads; file paths are relative to the research workspace when possible. No new fact is inferred by this index.",
      sections: ["core", "map", "readings", "directReadings", "checkpoints", "question", "inventory"].map(k => ({ pointer: `/body/${pointer(k)}` })) },
  };
  requireCondition(JSON.stringify(packet).length <= maxChars, "planning_context_limit", "Planning index exceeds its configured ceiling; narrow the planning scope without dropping constraints");
  return packet;
}
