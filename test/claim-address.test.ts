import { fixturePlanCoverage, validFrame, type PlanQuestion } from './discovery-v7-fixture.js';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISCOVERY_CLAIMS_CONTRACT, resolveClaimAddress, proveClaimAddress,
  type ClaimAddress } from "../src/discovery/claim-address.js";
import { type ResearchAnswer, type ResearchAssessment } from "../src/discovery/research-model.js";
import { Discovery, type DiscoveryDraft, type FieldSpec, type Question } from "../src/discovery/discovery.js";
import { V7_CONTRACT_ERA, DISCOVERY_ACCEPTANCE_ACT_KIND, DISCOVERY_ACCEPTANCE_ACT_CONTRACT,
  V7_ATTEMPT_KIND, V7_ATTEMPT_CONTRACT, V7_PLAN_FIELD,
  discoveryAcceptanceActId, type DiscoveryAcceptanceAct } from "../src/discovery/v7-contracts.js";
import { v7AttemptId, type V7Attempt, type V7AttemptEnd } from "../src/discovery/v7-plan-questions.js";
import { checkStoreIntegrity } from "../src/storage/fsck.js";
import { referenceSites } from "../src/storage/reference-sites.js";
import { reference, isRef, type Ref } from "../src/pipeline/contracts.js";
import { EngineError } from "../src/errors.js";
import { hashJson, type Json } from "../src/canonical.js";
import { Store, type Revision } from "../src/storage/store.js";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-dr2-claims-"));
  const store = new Store(join(root, "state.sqlite"));
  const discovery = new Discovery(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, discovery };
}

const thrown = (fn: () => unknown, code: string, includes?: string) => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${String(error)}`);
    assert.equal((error as EngineError).code, code, (error as EngineError).message);
    if (includes) assert.ok((error as EngineError).message.includes(includes), (error as EngineError).message);
    return error as EngineError;
  }
  assert.fail(`expected ${code}`);
};

const asJson = <T>(value: T): Json => value as unknown as Json;

/** Моделируемый договор claims: спек вопроса, чья схема принимает полезную
 * нагрузку {claims}. Сам договор ещё никем не производится (DR3a) — маркер
 * и выдачу моделирует фикстура, акт принятия пишется теми же ревизиями, что
 * пишет #answer. */
const CLAIMS_SPEC = { field: "claims", kind: "decision", prompt: "claims", risk: "claims",
  schema: { type: "object", required: ["claims"],
    properties: { claims: { type: "array" } } } as unknown as Json,
  proof: "assessment" } satisfies FieldSpec;

interface ClaimsFixture {
  container: Revision<ResearchAnswer>;
  draft: Revision<DiscoveryDraft>;
  question: Revision<Question>;
  claims: Json[];
  /** Оценка нового значения на тот же вопрос — для записей новых версий. */
  accepted: (claims: Json[], forQ?: Revision<Question>) => Revision<ResearchAssessment>;
  /** Законный акт принятия сохранёнными ревизиями: reopen при необходимости,
   * затем answered-ревизия вопроса и ревизия драфта с полем — те же формы,
   * что пишет #answer. */
  accept: (answer: Revision<ResearchAnswer>) => void;
}

/** A claims-answer container with a coherent saved acceptance history the way
 * the future v7 producer leaves it: the contract marker at the record body
 * root, claims inside value, a supported assessment of this exact value by an
 * independent assessor bound to a real question, and — unless accept:false —
 * the saved accepting question/draft revisions naming this exact record. */
function writeClaimsContainer(store: Store, discovery: Discovery, options: {
  project?: string; claims: Json[]; kind?: string; contractAtRoot?: boolean;
  assessment?: "accepted" | "dangling" | "insufficient" | "foreign" | "mismatch" | "dependent" | "shallow";
  spec?: FieldSpec; accept?: boolean;
}): ClaimsFixture {
  const project = options.project ?? "p";
  const rand = () => Math.random().toString(16).slice(2);
  const draftId = `discovery-draft:${project}:${rand()}`;
  const questionId = `question:${project}:${rand()}`;
  const draft = store.write<DiscoveryDraft>({ id: draftId, kind: "discovery-draft", expected: 0,
    value: { projectId: project, createdAt: 1, stage: "discovery", level: "R0",
      consumer: "om-g2", fields: { claims: null }, questions: [questionId], inputs: [],
      contractVersion: V7_CONTRACT_ERA } });
  const question = store.write<Question>({ id: questionId, kind: "question", expected: 0,
    value: { projectId: project, draftId, stage: "discovery", level: "R0", consumer: "om-g2",
      spec: options.spec ?? CLAIMS_SPEC, beforeHash: hashJson(null), status: "open", answer: null } });
  const source = discovery.evidence.document(project, `basis-${rand()}`,
    `Exact source for ${project}`, "text/plain", 0);
  const env = store.write({ id: `environment:${project}:${rand()}`,
    kind: "environment", expected: 0, value: { state: "ready" } });
  const writeAssessment = (claims: Json[], mode_: string, forQ?: Revision<Question>) => store.write<ResearchAssessment>({
    id: `research-assessment:${project}:${rand()}`,
    kind: "research-assessment", expected: 0,
    value: { projectId: mode_ === "foreign" ? "other" : project,
      question: reference(forQ ?? store.get<Question>(questionId)!),
      value: mode_ === "mismatch" ? { claims: [{ id: "different", kind: "fact", basis: null }] }
        : { claims },
      observations: mode_ === "shallow" ? [{} as Json] : [discovery.evidence.observe(project,
        reference(source), { kind: "text-range", start: 0, end: source.value.content.length })],
      verdict: mode_ === "insufficient" ? "insufficient" : "supported", reasons: [],
      researcher: "r", assessor: mode_ === "dependent" ? "r" : "a", environment: reference(env) } });
  const mode = options.assessment ?? "accepted";
  const assessment = mode === "dangling" ? null : writeAssessment(options.claims, mode, question);
  const body: Record<string, Json> = { projectId: project, question: question.id,
    assessment: assessment === null
      ? { id: `research-assessment:${project}:none`, revision: 1, hash: "0".repeat(64) }
      : asJson(reference(assessment)),
    value: { claims: options.claims } };
  if (options.contractAtRoot !== false) body["contract"] = DISCOVERY_CLAIMS_CONTRACT;
  const container = store.write<ResearchAnswer>({
    id: `research-answer:${project}:c-${rand()}`,
    kind: options.kind ?? "research-answer", expected: 0,
    value: body as unknown as ResearchAnswer });
  // The saved acceptance act: the same revision shapes Discovery.#answer
  // writes — reopen when the head is answered, then {status:'answered',
  // answer:ref} on the question and the field value on the draft.
  const accept = (answer: Revision<ResearchAnswer>) => {
    const head = store.get<Question>(questionId)!;
    if (head.value.status === "answered") {
      const d = store.get<DiscoveryDraft>(draftId)!;
      store.write<Question>({ id: questionId, kind: "question", expected: head.revision,
        value: { ...head.value, beforeHash: hashJson(d.value.fields["claims"]),
          status: "open", answer: null } });
    }
    const open = store.get<Question>(questionId)!;
    const d = store.get<DiscoveryDraft>(draftId)!;
    const draftBefore = reference(d);
    const questionBefore = reference(open);
    const draftAfter = { ...d.value, fields: { ...d.value.fields, claims: answer.value.value } };
    const draftAfterRef: Ref = { id: draftId, revision: d.revision + 1, hash: hashJson(draftAfter) };
    const questionAfter = { ...open.value, status: "answered" as const, answer: reference(answer) };
    const questionAfterRef: Ref = { id: questionId, revision: open.revision + 1, hash: hashJson(questionAfter) };
    const actId = discoveryAcceptanceActId(project, draftId, "claims", reference(answer));
    const actValue: DiscoveryAcceptanceAct = {
      contract: DISCOVERY_ACCEPTANCE_ACT_CONTRACT,
      projectId: project,
      draftId,
      field: "claims",
      draftBefore,
      draftAfter: draftAfterRef,
      questionBefore,
      questionAfter: questionAfterRef,
      answer: reference(answer),
      assessment: isRef(answer.value.assessment) ? answer.value.assessment : null,
      binding: null,
    };
    store.writeMany([
      { id: draftId, kind: "discovery-draft", expected: d.revision, value: draftAfter },
      { id: questionId, kind: "question", expected: open.revision, value: questionAfter },
      { id: actId, kind: DISCOVERY_ACCEPTANCE_ACT_KIND, expected: 0, value: actValue },
    ]);
  };
  if (options.accept !== false) accept(container);
  return { container, draft, question, claims: options.claims,
    accepted: (claims, forQ) => writeAssessment(claims, "accepted", forQ), accept };
}

const addressOf = (project: string, container: Revision<ResearchAnswer>, pointer: string,
  claimId: string, kind = "research-answer"): ClaimAddress =>
  ({ project, container: reference(container), containerKind: kind, pointer, claimId });

test("DR2: правильный адрес разрешается и доказывается по принятой цепочке", t => {
  const { store, discovery } = fixture(t);
  const { container } = writeClaimsContainer(store, discovery, { claims: [
    { id: "c-1", kind: "fact", basis: { source: { ref: { id: "source:s1", revision: 1, hash: "0".repeat(64) } } } },
    { id: "c-2", kind: "interpretation", basis: null } ] });
  const resolved = resolveClaimAddress(store, addressOf("p", container, "/claims/1", "c-2"));
  assert.equal((resolved.claim as Record<string, Json>)["id"], "c-2");
  assert.equal(resolved.container.id, container.id);
  assert.equal(resolved.container.revision, 1);
  const proven = proveClaimAddress(store, addressOf("p", container, "/claims/0", "c-1"));
  assert.equal(proven.container.id, container.id);
  assert.notEqual(proven.assessment, null);
});

test("DR2: разрешение и доказательство раздельны — непринятый контейнер адресуется, но не доказывается", t => {
  const { store, discovery } = fixture(t);
  // Оценка и контейнер на месте, акта принятия нет: вопрос open, answer=null,
  // поле драфта пусто — структура адресуется, доказательство отказывает.
  const { container } = writeClaimsContainer(store, discovery, {
    claims: [{ id: "c-1", kind: "fact", basis: null }], accept: false });
  const address = addressOf("p", container, "/claims/0", "c-1");
  const resolved = resolveClaimAddress(store, address); // структурно цел — но не принят
  assert.equal(resolved.container.id, container.id);
  thrown(() => proveClaimAddress(store, address), "claim_address_invalid", "never accepted");
});

test("DR2: доказательство — пробы ревьюера на происхождение оценки и отсутствующий акт", t => {
  const { store, discovery } = fixture(t);
  for (const [mode, label] of [["dangling", "missing assessment"], ["insufficient", "verdict"],
    ["foreign", "project"], ["mismatch", "value"], ["dependent", "independence"]] as const) {
    const { container } = writeClaimsContainer(store, discovery, {
      claims: [{ id: "c-1", kind: "fact", basis: null }], assessment: mode });
    const resolved = resolveClaimAddress(store, addressOf("p", container, "/claims/0", "c-1"));
    assert.equal(resolved.container.id, container.id, `${label}: разрешение структурно цело`);
    thrown(() => proveClaimAddress(store, addressOf("p", container, "/claims/0", "c-1")),
      "claim_address_invalid", "never accepted");
  }
});

test("DR2: точная ревизия и хеш — изменённый или отсутствующий контейнер отказывает", t => {
  const { store, discovery } = fixture(t);
  const { container } = writeClaimsContainer(store, discovery,
    { claims: [{ id: "c-1", kind: "fact", basis: null }] });
  const tampered: ClaimAddress = { project: "p", containerKind: "research-answer",
    pointer: "/claims/0", claimId: "c-1",
    container: { id: container.id, revision: 1, hash: "0".repeat(64) } };
  thrown(() => resolveClaimAddress(store, tampered), "claim_address_invalid", "container");
  const future: ClaimAddress = { project: "p", containerKind: "research-answer",
    pointer: "/claims/0", claimId: "c-1",
    container: { id: container.id, revision: 99, hash: container.hash } };
  thrown(() => resolveClaimAddress(store, future), "claim_address_invalid");
});

test("DR2: чужой проект, чужой вид, без договора и маркер в нагрузке — отказы", t => {
  const { store, discovery } = fixture(t);
  const { container } = writeClaimsContainer(store, discovery,
    { claims: [{ id: "c-1", kind: "fact", basis: null }] });
  thrown(() => resolveClaimAddress(store, addressOf("other", container, "/claims/0", "c-1")),
    "claim_address_invalid", "another project");
  thrown(() => resolveClaimAddress(store, addressOf("p", container, "/claims/0", "c-1", "fact")),
    "claim_address_invalid");
  const unmarked = writeClaimsContainer(store, discovery, {
    claims: [{ id: "c-1", kind: "fact", basis: null }], contractAtRoot: false });
  thrown(() => resolveClaimAddress(store, addressOf("p", unmarked.container, "/claims/0", "c-1")),
    "claim_address_invalid", "claims record");
  // Маркер внутри полезной нагрузки не включает договор.
  const payloadMarked = writeClaimsContainer(store, discovery, {
    claims: [{ id: "c-1", kind: "fact", basis: null }], contractAtRoot: false });
  store.write({ id: payloadMarked.container.id, kind: "research-answer", expected: 1, value: {
    ...payloadMarked.container.value, value: { contract: DISCOVERY_CLAIMS_CONTRACT,
      claims: [{ id: "c-1", kind: "fact", basis: null }] } } });
  thrown(() => resolveClaimAddress(store,
    addressOf("p", store.get<ResearchAnswer>(payloadMarked.container.id)!, "/claims/0", "c-1")),
    "claim_address_invalid", "claims record");
  // Контейнер — не research-answer.
  const foreign = writeClaimsContainer(store, discovery, {
    claims: [{ id: "c-1", kind: "fact", basis: null }], kind: "fact" });
  thrown(() => resolveClaimAddress(store, addressOf("p", foreign.container, "/claims/0", "c-1", "fact")),
    "claim_address_invalid");
});

test("DR2: указатель — форма, диапазон, несовпадение id, дубль id", t => {
  const { store, discovery } = fixture(t);
  const { container } = writeClaimsContainer(store, discovery, { claims: [
    { id: "c-1", kind: "fact", basis: null }, { id: "c-2", kind: "fact", basis: null } ] });
  for (const pointer of ["claims/0", "/claims", "/claims/-1", "/claims/x", "/claims/0/x", "/claims/",
    "/claims/00", "/claims/01"])
    thrown(() => resolveClaimAddress(store, addressOf("p", container, pointer, "c-1")),
      "claim_address_invalid", "pointer");
  thrown(() => resolveClaimAddress(store, addressOf("p", container, "/claims/9", "c-1")),
    "claim_address_invalid", "pointer");
  thrown(() => resolveClaimAddress(store, addressOf("p", container, "/claims/0", "c-2")),
    "claim_address_invalid", "another id");
  const duplicated = writeClaimsContainer(store, discovery, { claims: [
    { id: "c-1", kind: "fact", basis: null }, { id: "c-1", kind: "fact", basis: null } ] });
  thrown(() => resolveClaimAddress(store, addressOf("p", duplicated.container, "/claims/0", "c-1")),
    "claim_address_invalid", "not unique");
  // Некорректный адрес целиком — типизированный отказ.
  thrown(() => resolveClaimAddress(store, { project: "p" } as unknown as ClaimAddress),
    "claim_address_invalid");
});

test("DR2: историческая точная ссылка — после reopen и после законного нового принятия", t => {
  const { store, discovery } = fixture(t);
  const { container, accepted, accept, question } = writeClaimsContainer(store, discovery, { claims: [
    { id: "old-1", kind: "fact", basis: null }, { id: "old-2", kind: "fact", basis: null } ] });
  // Новая версия со своей оценкой нового значения — но без акта принятия:
  // структурно адресуется, доказательства у неё нет.
  const q = discovery.reopen(question.id, store.get<Question>(question.id)!.revision);
  const newClaims: Json[] = [{ id: "new-1", kind: "fact", basis: null }];
  const head = store.write<ResearchAnswer>({ id: container.id, kind: "research-answer", expected: 1,
    value: { ...container.value, assessment: asJson(reference(accepted(newClaims, q))),
      value: { claims: newClaims } } });
  const historical = resolveClaimAddress(store,
    addressOf("p", container, "/claims/1", "old-2")); // ref зафиксирован на rev1
  assert.equal((historical.claim as Record<string, Json>)["id"], "old-2");
  assert.equal(historical.container.revision, 1);
  assert.equal(head.revision, 2);
  thrown(() => proveClaimAddress(store, addressOf("p", head, "/claims/0", "new-1")),
    "claim_address_invalid", "never accepted");
  // Доказательство идёт по сохранённой ссылке — принятая первая версия подтверждается.
  const proven = proveClaimAddress(store, addressOf("p", container, "/claims/0", "old-1"));
  assert.equal(proven.container.revision, 1);
  assert.notEqual(proven.assessment, null);
  // Законное новое принятие: акт на новую ревизию — и она доказывается,
  // а исторический адрес первой остаётся доказуемым по её акту.
  accept(head);
  const freshProven = proveClaimAddress(store, addressOf("p", head, "/claims/0", "new-1"));
  assert.equal(freshProven.container.revision, 2);
  assert.equal(proveClaimAddress(store, addressOf("p", container, "/claims/0", "old-1"))
    .container.revision, 1);
});

test("DR2: обход ссылок — настоящие формы basis; свободные Ref-образные объекты — данные", t => {
  const { store, discovery } = fixture(t);
  const inner = writeClaimsContainer(store, discovery, {
    claims: [{ id: "inner-1", kind: "fact", basis: null }] });
  const innerAddress = addressOf("p", inner.container, "/claims/0", "inner-1");
  const sourceRef: Ref = { id: "source:s1", revision: 1, hash: "a".repeat(64) };
  const authorityRef: Ref = { id: "owner-session:p:s", revision: 1, hash: "b".repeat(64) };
  const { container } = writeClaimsContainer(store, discovery, { claims: [
    { id: "c-1", kind: "fact", basis: { source: { ref: asJson(sourceRef) } } },
    { id: "c-2", kind: "inference", basis: { from: asJson([innerAddress]) } },
    { id: "c-3", kind: "owner-decision", basis: { authority: asJson(authorityRef) } },
    { id: "c-4", kind: "fact", basis: null,
      notes: asJson({ id: "fake", revision: 1, hash: "f".repeat(64) }),
      freeform: asJson({ looks: { like: sourceRef } }) },
  ] });
  const sites = referenceSites("research-answer", container.value);
  const fields = sites.map(site => site.field).sort();
  assert.deepEqual(fields, [
    "assessment",
    "value.claims[0].basis.source.ref",
    "value.claims[1].basis.from[0].container",
    "value.claims[2].basis.authority",
  ]);
  assert.equal(sites.find(site => site.field === "value.claims[1].basis.from[0].container")!.ref.id,
    inner.container.id);
});

test("DR2: старая запись без корневого маркера — прежний обход; маркер в нагрузке договор не включает", t => {
  const { store, discovery } = fixture(t);
  const old = writeClaimsContainer(store, discovery, {
    claims: [{ id: "c-1", kind: "fact", basis: { source: { ref: { id: "source:s2", revision: 1,
      hash: "a".repeat(64) } } } }], contractAtRoot: false });
  const oldSites = referenceSites("research-answer", old.container.value);
  assert.equal(oldSites.length, 1);
  assert.equal(oldSites[0]!.field, "assessment");
  // Маркер внутри value не переключает правило.
  const nested = store.write<ResearchAnswer>({ id: `research-answer:p:nested`, kind: "research-answer",
    expected: 0, value: { projectId: "p", question: old.container.value.question,
      assessment: old.container.value.assessment,
      value: { contract: DISCOVERY_CLAIMS_CONTRACT,
        claims: [{ id: "c-1", kind: "fact", basis: { source: { ref: { id: "source:s2", revision: 1,
          hash: "a".repeat(64) } } } }] } } as unknown as ResearchAnswer });
  const nestedSites = referenceSites("research-answer", nested.value);
  assert.equal(nestedSites.length, 1);
  assert.equal(nestedSites[0]!.field, "assessment");
});

test("DR2: контрпримеры ревьюера — копия ответа, open-вопрос, мелкие наблюдения, чужая схема", t => {
  const { store, discovery } = fixture(t);
  // (1) Полная копия принятого контейнера под другим id: вопрос продолжает
  // ссылаться на исходный ответ — копия никогда не была принята.
  const { container } = writeClaimsContainer(store, discovery, {
    claims: [{ id: "c-1", kind: "fact", basis: null }] });
  const copy = store.write<ResearchAnswer>({ id: "research-answer:p:copy", kind: "research-answer",
    expected: 0, value: { ...container.value } });
  assert.ok(resolveClaimAddress(store, addressOf("p", copy, "/claims/0", "c-1")).container.id === copy.id);
  thrown(() => proveClaimAddress(store, addressOf("p", copy, "/claims/0", "c-1")),
    "claim_address_invalid", "never accepted");
  // (2) Акт на существование ссылки недостаточен: без answered-ревизии
  // вопроса и поля драфта принятия не было (покрыто accept:false выше) —
  // здесь поле драфта есть, а answered-ревизии нет.
  const partial = writeClaimsContainer(store, discovery, {
    claims: [{ id: "c-1", kind: "fact", basis: null }], accept: false });
  store.write<DiscoveryDraft>({ id: partial.draft.id, kind: "discovery-draft",
    expected: partial.draft.revision,
    value: { ...partial.draft.value, fields: { claims: partial.container.value.value } } });
  thrown(() => proveClaimAddress(store, addressOf("p", partial.container, "/claims/0", "c-1")),
    "claim_address_invalid", "never accepted");
  // (3) Наблюдения [{}] — формально непустой массив, фактически не наблюдения.
  const shallow = writeClaimsContainer(store, discovery, {
    claims: [{ id: "c-1", kind: "fact", basis: null }], assessment: "shallow" });
  thrown(() => proveClaimAddress(store, addressOf("p", shallow.container, "/claims/0", "c-1")),
    "claim_address_invalid", "never accepted");
  // (4) Полезная нагрузка не соответствует схеме вопроса — акт и оценка не
  // заменяют форму поля.
  const wrongShape = writeClaimsContainer(store, discovery, {
    claims: [{ id: "c-1", kind: "fact", basis: null }],
    spec: { ...CLAIMS_SPEC, schema: { type: "object", required: ["edition"],
      properties: { edition: { type: "number" } } } as unknown as Json } });
  thrown(() => proveClaimAddress(store, addressOf("p", wrongShape.container, "/claims/0", "c-1")),
    "claim_address_invalid", "never accepted");
});

test("DR2: fsck — висячие основания находятся по настоящим путям; согласованная запись чиста", t => {
  const { store, discovery } = fixture(t);
  const source = store.write({ id: "source:ok", kind: "source", expected: 0, value: { content: "b" } });
  const session = store.write({ id: "owner-session:p:ok", kind: "owner-session", expected: 0,
    value: { state: "open" } });
  const inner = writeClaimsContainer(store, discovery, {
    claims: [{ id: "inner-1", kind: "fact", basis: null }] });
  writeClaimsContainer(store, discovery, { claims: [
    { id: "c-1", kind: "fact", basis: { source: { ref: asJson(reference(source)) } } },
    { id: "c-2", kind: "inference", basis: { from: asJson([addressOf("p", inner.container, "/claims/0", "inner-1")]) } },
    { id: "c-3", kind: "owner-decision", basis: { authority: asJson(reference(session)) } },
  ] });
  let report = checkStoreIntegrity(store);
  let flagged = report.findings.filter(f => f.code === "reference_missing" || f.code === "reference_forged");
  assert.equal(flagged.length, 0, JSON.stringify(flagged, null, 2));
  // Висячий источник — находка по пути basis.source.ref.
  writeClaimsContainer(store, discovery, { claims: [
    { id: "c-4", kind: "fact", basis: { source: { ref: { id: "source:missing", revision: 1,
      hash: "0".repeat(64) } } } } ] });
  report = checkStoreIntegrity(store);
  flagged = report.findings.filter(f => f.code === "reference_missing"
    && f.field === "value.claims[0].basis.source.ref");
  assert.equal(flagged.length, 1, JSON.stringify(report.findings, null, 2));
  // Висячий контейнер вывода — находка по пути basis.from[0].container.
  writeClaimsContainer(store, discovery, { claims: [
    { id: "c-5", kind: "inference", basis: { from: [asJson({ project: "p",
      container: { id: "research-answer:p:ghost", revision: 1, hash: "0".repeat(64) },
      containerKind: "research-answer", pointer: "/claims/0", claimId: "ghost-1" })] } } ] });
  report = checkStoreIntegrity(store);
  flagged = report.findings.filter(f => f.code === "reference_missing"
    && f.field === "value.claims[0].basis.from[0].container");
  assert.equal(flagged.length, 1, JSON.stringify(report.findings, null, 2));
  // Подделанный источник (запись есть, хеш чужой) — reference_forged.
  writeClaimsContainer(store, discovery, { claims: [
    { id: "c-6", kind: "fact", basis: { source: { ref: { id: source.id, revision: 1,
      hash: "0".repeat(64) } } } } ] });
  report = checkStoreIntegrity(store);
  const forged = report.findings.filter(f => f.code === "reference_forged"
    && f.field === "value.claims[0].basis.source.ref");
  assert.equal(forged.length, 1, JSON.stringify(report.findings, null, 2));
});

test("DR2: контрпримеры связности акта принятия — отказ proveClaimAddress", t => {
  // Контрпример 1 ревьюера: stale assessment на reopen-вопросе со связанным draft
  {
    const { store, discovery } = fixture(t);
    const f = writeClaimsContainer(store, discovery, { claims: [{ id: "c-1", kind: "fact", basis: null }] });
    const q = discovery.reopen(f.question.id, store.get<Question>(f.question.id)!.revision);
    const oldAssessment = store.get<ResearchAssessment>(f.container.value.assessment.id)!;
    const copy = store.write<ResearchAnswer>({ id: "research-answer:p:claims-stale-copy",
      kind: f.container.kind, expected: 0,
      value: { ...f.container.value, assessment: reference(oldAssessment) } });
    const d = store.get<DiscoveryDraft>(f.draft.id)!;
    store.write<DiscoveryDraft>({ id: d.id, kind: d.kind, expected: d.revision,
      value: { ...d.value, fields: { ...d.value.fields, claims: copy.value.value } } });
    store.write<Question>({ id: q.id, kind: q.kind, expected: q.revision,
      value: { ...q.value, status: "answered", answer: reference(copy) } });
    thrown(() => proveClaimAddress(store, addressOf("p", copy, "/claims/0", "c-1")),
      "claim_address_invalid", "never accepted");
  }

  // Контрпример 2 ревьюера: свежий assessment и answered-ревизия вопроса БЕЗ перехода draft
  {
    const { store, discovery } = fixture(t);
    const f = writeClaimsContainer(store, discovery, { claims: [{ id: "c-1", kind: "fact", basis: null }] });
    const q = discovery.reopen(f.question.id, store.get<Question>(f.question.id)!.revision);
    const oldAssessment = store.get<ResearchAssessment>(f.container.value.assessment.id)!;
    const assessment = store.write<ResearchAssessment>({ id: "research-assessment:p:fresh-copy",
      kind: oldAssessment.kind, expected: 0,
      value: { ...oldAssessment.value, question: reference(q) } });
    const copy = store.write<ResearchAnswer>({ id: "research-answer:p:claims-q-only",
      kind: f.container.kind, expected: 0,
      value: { ...f.container.value, assessment: reference(assessment) } });
    // draft НЕ перезаписывается — остаётся старая ревизия!
    store.write<Question>({ id: q.id, kind: q.kind, expected: q.revision,
      value: { ...q.value, status: "answered", answer: reference(copy) } });
    thrown(() => proveClaimAddress(store, addressOf("p", copy, "/claims/0", "c-1")),
      "claim_address_invalid", "never accepted");
  }

  // Контрпример ревьюера №5993: повторное законное принятие того же claims, затем поддельный 3-й ответ без draft
  {
    const { store, discovery } = fixture(t);
    const f = writeClaimsContainer(store, discovery, { claims: [{ id: "c-1", kind: "fact", basis: null }] });
    // Второе законное принятие того же значения claims:
    const q2 = discovery.reopen(f.question.id, store.get<Question>(f.question.id)!.revision);
    const assessment2 = f.accepted(f.claims, q2);
    const head2 = store.write<ResearchAnswer>({
      id: f.container.id,
      kind: f.container.kind,
      expected: f.container.revision,
      value: { ...f.container.value, assessment: asJson(reference(assessment2)) },
    });
    f.accept(head2);

    const acceptedQ = store.get<Question>(f.question.id)!;
    const a = store.get<ResearchAnswer>(acceptedQ.value.answer!.id, acceptedQ.value.answer!.revision)!;
    const oldAssessment = store.get<ResearchAssessment>(a.value.assessment.id)!;

    // Третий поддельный ответ со свежим assessment, но без записи draft:
    const q3 = discovery.reopen(f.question.id, acceptedQ.revision);
    const assessment3 = store.write<ResearchAssessment>({ id: "research-assessment:p:claims-repeat-third",
      kind: oldAssessment.kind, expected: 0,
      value: { ...oldAssessment.value, question: reference(q3) } });
    const copy = store.write<ResearchAnswer>({ id: "research-answer:p:claims-repeat-third-copy",
      kind: f.container.kind, expected: 0,
      value: { ...f.container.value, assessment: reference(assessment3) } });
    store.write<Question>({ id: q3.id, kind: q3.kind, expected: q3.revision,
      value: { ...q3.value, status: "answered", answer: reference(copy) } });

    thrown(() => proveClaimAddress(store, addressOf("p", copy, "/claims/0", "c-1")),
      "claim_address_invalid", "never accepted");
  }
});

/* ---------- DR3a1: маршрут попытки ---------- */

const rand = () => Math.random().toString(16).slice(2);

/** Моделируемая принятая редакция плана: v7-драфт, вопрос plan со спекой
 * V7_PLAN_FIELD, ответ с планом и сохранённый акт принятия — те же формы
 * ревизий, что пишет #answer (DR3a1-фикстура). */
function writePlanAccepted(store: Store, discovery: Discovery, options: {
  project?: string; questions: Json[];
}): { draft: Revision<DiscoveryDraft>; question: Revision<Question>; planAnswer: Ref } {
  const project = options.project ?? "p";
  const draftId = `discovery-draft:${project}:${rand()}`;
  const questionId = `question:${project}:${rand()}`;
  const draft = store.write<DiscoveryDraft>({ id: draftId, kind: "discovery-draft", expected: 0,
    value: { projectId: project, createdAt: 1, stage: "discovery", level: "R0",
      consumer: "om-g2", fields: { frame: validFrame(options.questions as PlanQuestion[]), plan: null }, questions: [questionId], inputs: [],
      contractVersion: V7_CONTRACT_ERA } });
  const question = store.write<Question>({ id: questionId, kind: "question", expected: 0,
    value: { projectId: project, draftId, stage: "discovery", level: "R0", consumer: "om-g2",
      spec: V7_PLAN_FIELD, beforeHash: hashJson(null), status: "open", answer: null } });
  const planValue = { edition: 1,
    frame: { id: `research-answer:${project}:frame`, revision: 1, hash: hashJson("frame") },
    previous: null, questions: options.questions, coverage: fixturePlanCoverage(options.questions as PlanQuestion[]) } as unknown as Json;
  const source = discovery.evidence.document(project, `basis-${rand()}`, "s", "text/plain", 0);
  const env = store.write({ id: `environment:${project}:${rand()}`, kind: "environment",
    expected: 0, value: { state: "ready" } });
  const assessment = store.write<ResearchAssessment>({
    id: `research-assessment:${project}:${rand()}`, kind: "research-assessment", expected: 0,
    value: { projectId: project, question: reference(question), value: planValue,
      observations: [discovery.evidence.observe(project, reference(source),
        { kind: "text-range", start: 0, end: source.value.content.length })],
      verdict: "supported", reasons: [], researcher: "r", assessor: "a",
      environment: reference(env) } });
  const answer = store.write<ResearchAnswer>({
    id: `research-answer:${project}:plan-${rand()}`, kind: "research-answer", expected: 0,
    value: { projectId: project, question: questionId,
      assessment: asJson(reference(assessment)), value: planValue } as unknown as ResearchAnswer });
  const draftAfter = { ...draft.value, fields: { ...draft.value.fields, plan: planValue } };
  const questionAfter = { ...question.value, status: "answered" as const, answer: reference(answer) };
  store.writeMany([
    { id: draftId, kind: "discovery-draft", expected: draft.revision, value: draftAfter },
    { id: questionId, kind: "question", expected: question.revision, value: questionAfter },
    { id: discoveryAcceptanceActId(project, draftId, "plan", reference(answer)),
      kind: DISCOVERY_ACCEPTANCE_ACT_KIND, expected: 0,
      value: { contract: DISCOVERY_ACCEPTANCE_ACT_CONTRACT, projectId: project, draftId,
        field: "plan", draftBefore: reference(draft),
        draftAfter: { id: draftId, revision: draft.revision + 1, hash: hashJson(draftAfter) },
        questionBefore: reference(question),
        questionAfter: { id: questionId, revision: question.revision + 1, hash: hashJson(questionAfter) },
        answer: reference(answer), assessment: reference(assessment),
        binding: null } satisfies DiscoveryAcceptanceAct },
  ]);
  return { draft: store.get<DiscoveryDraft>(draftId)!, question: store.get<Question>(questionId)!,
    planAnswer: reference(answer) };
}

function writeCallRecord(store: Store, projectId: string, draftId: string, questionId: string,
  planAnswer: Ref) {
  return store.write({ id: `model-call:${projectId}:${questionId}:${rand()}`, kind: "model-call",
    expected: 0, value: { projectId, draftId, questionId, planAnswer: asJson(planAnswer),
      purpose: "research", requestId: `r-${rand()}`, startedAt: 1, finishedAt: 2,
      status: "succeeded",
      requested: { actor: "fixture", model: "fixture", effort: "medium",
        command: { executable: "fixture", args: [] } },
      confirmed: { model: "fixture", effort: "medium", speed: null },
      request: { chars: 10, bytes: 10, hash: hashJson("req") },
      response: { chars: 20, bytes: 20 },
      usage: null, usageSource: "unavailable", error: null } });
}

function writeAttemptRecord(store: Store, opts: { project: string; draft: Ref; planAnswer: Ref;
  planQuestionId: string; call: Ref; end: V7AttemptEnd; id?: string }): Revision<V7Attempt> {
  const key = { project: opts.project, planAnswer: opts.planAnswer,
    planQuestionId: opts.planQuestionId, call: opts.call };
  const value: V7Attempt = { contract: V7_ATTEMPT_CONTRACT, ...key, draft: opts.draft, end: opts.end };
  return store.write<V7Attempt>({ id: opts.id ?? v7AttemptId(key), kind: V7_ATTEMPT_KIND,
    expected: 0, value });
}

function attemptFactClaim(store: Store, project: string, id: string, planAnswer: Ref,
  planQuestionId: string, overrides: Record<string, Json> = {}): Json {
  const src = store.write({ id: `source:${project}:${rand()}`, kind: "source", expected: 0,
    value: { projectId: project, content: "basis" } });
  return { id, kind: "fact", text: `Claim ${id}`, axis: "market",
    planQuestions: [{ planAnswer: asJson(planAnswer), planQuestionId }],
    scope: { variants: "common" },
    basis: { source: { ref: asJson(reference(src)), range: { start: 0, end: 3 },
      valueHash: hashJson("v") }, limit: "snapshot", asOf: "2026-10" },
    ...overrides } as unknown as Json;
}

const attemptAddress = (project: string, attempt: Revision<V7Attempt>, pointer: string,
  claimId: string): ClaimAddress =>
  ({ project, container: reference(attempt), containerKind: V7_ATTEMPT_KIND, pointer, claimId });

const PLAN_QUESTIONS = [{ id: "q-blk", axis: "rules", domain: "construction",
  text: "What covers q-blk?", class: "blocking", criterion: "named basis",
  requiredDepth: "deep", roles: ["expert"], searchPlaces: ["docs"] },
  { id: "q-sup", axis: "market", domain: "construction", text: "What covers q-sup?",
    class: "supporting", criterion: "named basis", requiredDepth: "deep",
    roles: ["expert"], searchPlaces: ["docs"] }] as unknown as Json[];

test("DR3a1: маршрут попытки — resolve цел, prove отказывает claim_attempt_not_accepted", t => {
  const { store, discovery } = fixture(t);
  const { draft, planAnswer } = writePlanAccepted(store, discovery,
    { project: "p", questions: PLAN_QUESTIONS });
  const call = writeCallRecord(store, "p", draft.id, "q-blk", planAnswer);
  const attempt = writeAttemptRecord(store, { project: "p", draft: reference(draft), planAnswer,
    planQuestionId: "q-blk", call: reference(call),
    end: { type: "submitted", contract: DISCOVERY_CLAIMS_CONTRACT, value: { claims: [
      attemptFactClaim(store, "p", "c-1", planAnswer, "q-blk"),
      attemptFactClaim(store, "p", "c-2", planAnswer, "q-blk")] } } });
  const resolved = resolveClaimAddress(store, attemptAddress("p", attempt, "/claims/1", "c-2"));
  assert.equal((resolved.claim as Record<string, Json>)["id"], "c-2");
  assert.equal(resolved.container.id, attempt.id);
  const refused = thrown(() => proveClaimAddress(store,
    attemptAddress("p", attempt, "/claims/0", "c-1")), "claim_attempt_not_accepted");
  assert.ok(refused !== null);
});

test("DR3a1: маршрут попытки — повреждённые, чужие и не-submitted попытки отказывают без fallback", t => {
  const { store, discovery } = fixture(t);
  const { draft, planAnswer } = writePlanAccepted(store, discovery,
    { project: "p", questions: PLAN_QUESTIONS });
  const call = writeCallRecord(store, "p", draft.id, "q-blk", planAnswer);
  const good = writeAttemptRecord(store, { project: "p", draft: reference(draft), planAnswer,
    planQuestionId: "q-blk", call: reference(call),
    end: { type: "submitted", contract: DISCOVERY_CLAIMS_CONTRACT, value: { claims: [
      attemptFactClaim(store, "p", "c-1", planAnswer, "q-blk")] } } });
  // Чужой проект в адресе.
  thrown(() => resolveClaimAddress(store, attemptAddress("other", good, "/claims/0", "c-1")),
    "claim_address_invalid", "another project");
  // Не-submitted конец — структурно согласованная попытка, но claims нет.
  const refused = writeAttemptRecord(store, { project: "p", draft: reference(draft), planAnswer,
    planQuestionId: "q-blk",
    call: reference(writeCallRecord(store, "p", draft.id, "q-blk", planAnswer)),
    end: { type: "refused", code: "outside_plan_scope", evidence: [], text: "x" } });
  thrown(() => resolveClaimAddress(store, attemptAddress("p", refused, "/claims/0", "c-1")),
    "claim_address_invalid", "submitted");
  // Повреждённая попытка (подменённый контракт тела) — отказ на resolve, prove тоже.
  const tampered = store.write<V7Attempt>({ id: good.id, kind: V7_ATTEMPT_KIND, expected: good.revision,
    value: { ...good.value, contract: "other/v9" as typeof V7_ATTEMPT_CONTRACT } });
  thrown(() => resolveClaimAddress(store, attemptAddress("p", tampered, "/claims/0", "c-1")),
    "claim_address_invalid");
  thrown(() => proveClaimAddress(store, attemptAddress("p", tampered, "/claims/0", "c-1")),
    "claim_address_invalid");
  // Указатель вне списка и чужой claimId.
  const whole = writeAttemptRecord(store, { project: "p", draft: reference(draft), planAnswer,
    planQuestionId: "q-blk",
    call: reference(writeCallRecord(store, "p", draft.id, "q-blk", planAnswer)),
    end: { type: "submitted", contract: DISCOVERY_CLAIMS_CONTRACT, value: { claims: [
      attemptFactClaim(store, "p", "c-1", planAnswer, "q-blk")] } } });
  thrown(() => resolveClaimAddress(store, attemptAddress("p", whole, "/claims/5", "c-1")),
    "claim_address_invalid", "pointer");
  thrown(() => resolveClaimAddress(store, attemptAddress("p", whole, "/claims/0", "c-9")),
    "claim_address_invalid", "another id");
  // Попытка с битым claims (пустая коллекция) — повреждение внутри, отказ.
  const broken = writeAttemptRecord(store, { project: "p", draft: reference(draft), planAnswer,
    planQuestionId: "q-blk",
    call: reference(writeCallRecord(store, "p", draft.id, "q-blk", planAnswer)),
    end: { type: "submitted", contract: DISCOVERY_CLAIMS_CONTRACT, value: { claims: [] } } });
  thrown(() => resolveClaimAddress(store, attemptAddress("p", broken, "/claims/0", "c-1")),
    "claim_address_invalid");
  // Чужой вид записи по адресу попытки — отказ.
  thrown(() => resolveClaimAddress(store, { project: "p", container: reference(call),
    containerKind: V7_ATTEMPT_KIND, pointer: "/claims/0", claimId: "c-1" }),
    "claim_address_invalid");
});

