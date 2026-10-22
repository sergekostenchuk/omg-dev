import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EngineError } from "../src/errors.js";
import { pendingOverlay, storeView } from "../src/storage/store-view.js";
import { canonical } from "../src/canonical.js";
import type { Graph } from "../src/graph/model.js";
import { reference, STAGE_CLOSURE_CONTRACT, type Ref } from "../src/pipeline/contracts.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import { Store, storeReads, observeStore, type Revision, type TransactionGuard } from "../src/storage/store.js";
import { writeOmInput } from "../src/om/input.js";
import { transactionForTests } from "../src/om/atomic-gate.js";
import { writeGuarded } from "../src/om/refs.js";
import { type OmResult, REFUSAL_ROUTES } from "../src/om/refusal.js";
import {
  prepareHorizon, writeHorizon, type HorizonRequest,
} from "../src/om/horizon.js";
import {
  prepareFrame, prepareHorizonBasis, prepareLayerAcceptance, type FrameRequest, type FrameLevel, type FrameScope,
} from "../src/om/frame-obligations.js";
import { createOmFixture, explicitMapping, gardenGraph, type OmFixture } from "./om-fixture.js";

import { Refinement } from "../src/graph/refinement.js";
import { ProductEngine } from "../src/product/engine.js";
import { projectGraph } from "../src/graph/project.js";
import { preparedFeatures } from "./product-fixture.js";
import { writeCandidate, gateCandidate } from "../src/om/frame-candidate.js";
import { settleCandidate } from "../src/om/frame-accept.js";
import type { LayerProposal } from "../src/om/frame-proposals.js";

const clone = <T>(value: T): T => structuredClone(value);
const producer = "garden-produce-block", consumer = "garden-consume-block", later = "garden-later-block";
const data = "garden-data", resultArtifact = "garden-result";

function delivered<T>(value: OmResult<T>): T {
  if (!value.ok) assert.fail(`Unexpected refusal ${value.refusal.code} at ${canonical(value.refusal.at)}: ${value.refusal.message}`);
  return value.value;
}

function refusedAs<T>(value: OmResult<T>, expected: string) {
  if (value.ok) assert.fail(`Expected ${expected}, got success`);
  assert.equal(value.refusal.code, expected);
  assert.ok(value.refusal.at.target.length > 0);
  assert.ok(REFUSAL_ROUTES.includes(value.refusal.route));
  return value.refusal;
}

async function storedHorizonFixture(t: TestContext) {
  const f = await createOmFixture(t, "standard", "garden", { mode: "executed" });
  const input = f.store.get("om-input:garden")!;
  const req: HorizonRequest = {
    project: f.project,
    input: reference(input),
    graph: reference(f.graphRevision),
    refinement: reference(f.layers[2]),
    choice: {
      choiceVersion: "choice-1",
      features: [{ outcome: resultArtifact }],
      excluded: [
        { block: later, reason: "Later feature is outside this delivery", returnCondition: "Owner selects later feature" },
        { block: "garden-refusal-block", reason: "Refusal result is outside this delivery", returnCondition: "Owner selects refusal result" },
      ],
    },
    available: {
      [producer]: { [data]: reference(f.receipts[data]!) },
      [consumer]: { [resultArtifact]: reference(f.receipts[resultArtifact]!) },
    },
  };
  return { f, req, input };
}

function acceptedInput(store: Store): Ref {
  const existing = store.get("om-input:garden");
  if (existing) return reference(existing);
  return reference(delivered(writeOmInput(store, {
    project: "garden", expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:garden:${stage}`)!)])) as Record<UpstreamStage, Ref>,
  })));
}

function acceptedHorizon(store: Store, refinement: Ref | null) {
  const input = acceptedInput(store);
  const existing = store.get("horizon:garden:frame-choice");
  const gate = store.get("om-horizon:garden:frame-choice");
  if (existing && gate) return { horizon: existing, gate };
  return delivered(writeHorizon(store, {
    project: "garden", input, graph: reference(store.get("graph:garden")!),
    refinement, choice: { choiceVersion: "frame-choice", features: [{ outcome: "garden-result" }], excluded: [] }, available: {},
  }));
}

function frameRequestFor(f: OmFixture, horizon: Ref, level: FrameLevel): FrameRequest {
  return {
    project: f.project, level, horizon, graph: reference(f.graphRevision), layer: reference(f.layers[level]),
    frame: reference(f.store.get(`om-frame:${f.project}:${level}`)!),
    upper: level === 2 ? null : { horizon, frame: reference(f.store.get(`om-frame:${f.project}:2`)!) },
  };
}

function committedFrameFixture(t: TestContext, absence?: string) {
  const root = mkdtempSync(join(tmpdir(), "omg-g3-committed-frame-")), database = join(root, "state.sqlite");
  const store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const validate = engine.checks.validateStage.bind(engine.checks);
  engine.checks.validateStage = (stage, context) => {
    const checked = validate(stage, context);
    if (!checked.findings.length) checked.closure = { contract: STAGE_CLOSURE_CONTRACT,
      external: stage === 'discovery' ? [{ kind: 'source', ref: reference(store.get('source:garden:brief')!) }] : [] };
    if (absence && stage === 'features' && !checked.findings.length)
      checked.admissionGuards = [...(checked.admissionGuards ?? []), { id: absence, absent: true }];
    return checked;
  };
  const graph = gardenGraph(), { level: _level, ...projection } = projectGraph(graph, 1);
  preparedFeatures(engine, 'garden', projection as Graph);
  const initial = acceptedHorizon(store, null), input = acceptedInput(store);
  const original: FrameRequest = { project: "garden", level: 2, horizon: reference(initial.gate),
    graph: reference(store.get("graph:garden")!), layer: null, frame: null, upper: null };
  const prepared = delivered(prepareFrame(store, original)), design = projectGraph(graph, 2);
  const fills = explicitMapping(graph, prepared.upper as Graph, prepared.scope as FrameScope, 2).fills;
  const proposal: LayerProposal = { base: { graph: original.graph, frame: null }, level: 2, source: "decision", status: "proposed",
    nodes: clone(design.nodes.filter(node => node.kind === "operation")),
    fills: fills.map(fill => ({ obligation: fill.obligation, node: fill.node, ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: clone(design.connectors.map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) }))
      .filter(connector => connector.bindings.length > 0)),
    artifacts: clone(design.artifacts), contracts: clone(design.contracts), joins: clone(design.joins), tests: clone(design.tests),
    edges: clone(design.edges ?? []), journeys: clone(design.journeys ?? []), packets: clone(design.packets ?? []),
    transfers: clone(design.transfers ?? []), anchors: clone(design.anchors), removes: [], replaces: [], redefines: [] };
  const offered = store.write({ id: "om-proposal:garden:consumer-design", kind: "layer-proposal", expected: 0, value: proposal });
  const written = delivered(writeCandidate(store, { frame: original, proposals: [reference(offered)] }));
  assert.ok(written.state === "candidate");
  const candidate = reference(written.record), gate = delivered(gateCandidate(store, { project: "garden", candidate }));
  const settled = delivered(settleCandidate(store, { project: "garden", level: 2, candidate,
    outcome: { gate: "G3", candidate, graphHash: gate.graphHash, passed: true, codes: [] } }));
  assert.equal(settled.state, "accepted"); assert.ok(settled.graph && settled.layer && settled.frame);
  const request: FrameRequest = { ...original, graph: reference(settled.graph), layer: reference(settled.layer), frame: reference(settled.frame) };

  const horizonRequest: HorizonRequest = { project: 'garden', input, graph: request.graph, refinement: request.layer,
    choice: { choiceVersion: 'after-om-acceptance', features: [{ outcome: 'garden-result' }], excluded: [] }, available: {} };
  const horizon = delivered(writeHorizon(store, horizonRequest));
  assert.equal(horizon.gate.value.state, 'accepted');
  return { store, database, horizonRequest, request: { ...request, horizon: reference(horizon.gate) } };
}

const countReads = (action: () => void): number => {
  const before = storeReads();
  action();
  return storeReads() - before;
};

test("prepareHorizon numerical storeReads budget: O(1) reads with batch headsMatch and fast existing replay", async t => {
  const { f, req } = await storedHorizonFixture(t);

  // Fresh prepareHorizon on accepted prefix: batch headsMatch handles prerequisites in 1 chunk
  const freshReads = countReads(() => {
    const prepared = delivered(prepareHorizon(f.store, req));
    assert.equal(prepared.existing, null);
    assert.ok(prepared.guards.length > 0);
  });
  // Fresh prepareHorizon on the accepted OM layer path is bounded (includes StageChecks in G1 era)
  assert.ok(freshReads <= 1000, `Fresh prepareHorizon reads ${freshReads} must be <= 1000`);

  // Save the horizon
  const saved = delivered(writeHorizon(f.store, req));

  // Repeated prepareHorizon: replayed from store without writes
  const replayReads = countReads(() => {
    const replayed = delivered(prepareHorizon(f.store, req));
    assert.deepEqual(replayed.existing, saved);
    assert.equal(replayed.writes.length, 0);
  });
  assert.ok(replayReads <= 1000, `Replay prepareHorizon reads ${replayReads} must be <= 1000`);
});

test("prepareHorizon fast existing replay budget <= 13 reads on G3a closure", async t => {
  const f = committedFrameFixture(t), cold = new Store(f.database);
  t.after(() => cold.close());
  const replayReads = countReads(() => {
    delivered(prepareHorizon(cold, f.horizonRequest));
  });
  // 13 = replay 3 + prerequisite heads 1 + current B1/stage admission 6 + accepted layer 3 (№6498).
  assert.ok(replayReads <= 13, `Replay prepareHorizon reads ${replayReads} must be <= 13 on G3a closure`);
});

test("prepareFrame numerical storeReads budget for level 2 and level 3", async t => {
  const f = await createOmFixture(t, "standard", "garden", { mode: "executed" });
  const horizon = acceptedHorizon(f.store, reference(f.layers[2]));

  // Prepare level 2 frame: batch headsMatch checks prerequisites in 1 chunk
  const reqL2 = frameRequestFor(f, reference(horizon.gate), 2);
  const l2Reads = countReads(() => {
    const prepared = delivered(prepareFrame(f.store, reqL2));
    assert.ok(prepared.guards.length > 0);
  });
  assert.ok(l2Reads <= 800, `Level 2 prepareFrame reads ${l2Reads} must be <= 800`);

  // Prepare level 3 frame
  const reqL3 = frameRequestFor(f, reference(horizon.gate), 3);
  const l3Reads = countReads(() => {
    const prepared = delivered(prepareFrame(f.store, reqL3));
    assert.ok(prepared.guards.length > 0);
  });
  assert.ok(l3Reads <= 1500, `Level 3 prepareFrame reads ${l3Reads} must be <= 1500`);
});

test("prepareFrame numerical storeReads budget <= 35 reads on G3a closure", async t => {
  const f = committedFrameFixture(t), cold = new Store(f.database);
  t.after(() => cold.close());
  const l2Reads = countReads(() => {
    delivered(prepareFrame(cold, f.request));
  });
  assert.ok(l2Reads <= 35, `Level 2 prepareFrame reads ${l2Reads} must be <= 35 on G3a closure`);
});

test("10x noise history invariant: adding 100 unrelated records causes 0 increase in storeReads", async t => {
  const { f, req } = await storedHorizonFixture(t);
  const horizon = acceptedHorizon(f.store, reference(f.layers[2]));
  const reqFrame = frameRequestFor(f, reference(horizon.gate), 2);

  // Baseline reads before noise injection (using isolated store instances with warm-up)
  const baseStoreH = new Store(f.database);
  delivered(prepareHorizon(baseStoreH, req));
  const baselineHorizonReads = countReads(() => { delivered(prepareHorizon(baseStoreH, req)); });
  baseStoreH.close();

  const baseStoreF = new Store(f.database);
  delivered(prepareFrame(baseStoreF, reqFrame));
  const baselineFrameReads = countReads(() => { delivered(prepareFrame(baseStoreF, reqFrame)); });
  baseStoreF.close();

  // Inject 100 noisy revisions of unrelated entities
  for (let i = 0; i < 100; i++) {
    f.store.write({
      id: `noise:artifact:${i}`,
      kind: "noise-artifact",
      expected: 0,
      value: { index: i, text: `Noise record ${i} added for 10x history invariant test` },
    });
  }

  // Reads after 100 noise records added (using isolated store instances with warm-up)
  const noiseStoreH = new Store(f.database);
  delivered(prepareHorizon(noiseStoreH, req));
  const noiseHorizonReads = countReads(() => { delivered(prepareHorizon(noiseStoreH, req)); });
  noiseStoreH.close();

  const noiseStoreF = new Store(f.database);
  delivered(prepareFrame(noiseStoreF, reqFrame));
  const noiseFrameReads = countReads(() => { delivered(prepareFrame(noiseStoreF, reqFrame)); });
  noiseStoreF.close();

  // Invariant: Delta reads must be exactly 0
  assert.equal(noiseHorizonReads, baselineHorizonReads,
    `prepareHorizon reads with 10x history (${noiseHorizonReads}) must equal baseline (${baselineHorizonReads})`);
  assert.equal(noiseFrameReads, baselineFrameReads,
    `prepareFrame reads with 10x history (${noiseFrameReads}) must equal baseline (${baselineFrameReads})`);
});

test("graph drift: L1 projection changes affect derivation, while same-value revision is caught by commit guard", async t => {
  const { f, req } = await storedHorizonFixture(t);

  // 1. Same-value graph revision (bump revision without changing content)
  const prepared = delivered(prepareHorizon(f.store, req));
  // The prepared transaction guards retain the exact current graph Ref
  assert.ok(prepared.guards.some(g => !('absent' in g) && g.id === req.graph.id && g.revision === req.graph.revision));

  // A concurrent writer bumps graph:<project> to revision + 1 with same content
  const graphRec = f.store.get<Graph>(req.graph.id)!;
  f.store.write({
    id: graphRec.id,
    kind: graphRec.kind,
    expected: graphRec.revision,
    value: graphRec.value,
  });

  // The prepared transaction cannot commit because request.graph was a read guard
  const writeResult = writeGuarded(f.store, {
    unit: "G2",
    target: f.project,
    writes: prepared.writes,
    guards: prepared.guards,
  });
  const refusal = refusedAs(writeResult, "input_stale");
  assert.equal(refusal.at.target, req.graph.id);

  // Calling prepareHorizon again after graph bump detects that req.graph is stale
  refusedAs(prepareHorizon(f.store, req), "input_stale");
});

// The accepted G3a admission boundary returns full TransactionGuard[]. Supply that boundary
// while keeping every preparation and transaction below it real; never append guards after preparation.
async function withAbsentAdmission(name: string, dependencies: Record<string, string> = {}, inject = false) {
  const path = new URL(`../src/om/${name}.js`, import.meta.url), require = createRequire(import.meta.url);
  let code = readFileSync(path, 'utf8');
  if (inject) {
    // Current OM preparation receives admission through B1, independently of the removed research-phase branch.
    const symbol = 'prepareExistingOmInput';
    assert.ok(code.includes(symbol), `${name} imports ${symbol}`);
    code = code.replace(symbol, `${symbol} as original_${symbol}`);
    code += `\nfunction ${symbol}(...args) { const r=original_${symbol}(...args); return r.ok
      ? {...r,value:{...r.value, guards:[...r.value.guards, {id:"g3b:producer-absence", absent:true}]}} : r; }`;
  }
  code = code.replace(/from (["'])([^"']+)\1/g, (_match, _quote, spec: string) => {
    const url = dependencies[spec] ?? (spec.startsWith('.') ? new URL(spec, path).href
      : spec.startsWith('node:') ? spec : pathToFileURL(require.resolve(spec)).href);
    return `from ${JSON.stringify(url)}`;
  });
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  return { url, api: await import(url) };
}

test("absent admission survives horizon, frame and downstream preparation and rolls back the whole batch", async t => {
  const { f, req } = await storedHorizonFixture(t);
  const saved = delivered(writeHorizon(f.store, req));
  const frame = frameRequestFor(f, reference(saved.gate), 2);
  const h = await withAbsentAdmission('horizon', {}, true);
  const b = await withAbsentAdmission('frame-obligations', {}, true);
  const p = await withAbsentAdmission('frame-proposals', { './frame-obligations.js': b.url });
  const c = await withAbsentAdmission('frame-candidate', { './frame-proposals.js': p.url, './frame-obligations.js': b.url });
  const g = await withAbsentAdmission('gaps', { './frame-proposals.js': p.url });
  const w = await withAbsentAdmission('work-zone', { './frame-obligations.js': b.url });
  const sources = [
    ['horizon', h.api.prepareHorizon(f.store, req)],
    ['horizon-basis', b.api.prepareHorizonBasis(f.store, { project:f.project, graph:frame.graph, horizon:frame.horizon })],
    ['frame', b.api.prepareFrame(f.store, frame)],
    ['proposals', p.api.prepareFrameProposals(f.store, { frame, proposals:[] })],
    ['candidate', c.api.prepareCandidate(f.store, { frame, proposals:[] })],
    ['work-zone', w.api.prepareWorkZone(f.store, {project:f.project,graph:frame.graph,layer:frame.layer,horizon:frame.horizon,frame:frame.frame})],
    ['gaps', g.api.prepareGaps(f.store, {project:f.project,input:req.input,graph:frame.graph,horizon:frame.horizon,
      operations:{frame,proposals:[]}, works:{frame:frameRequestFor(f,reference(saved.gate),3),proposals:[]}})],
  ] as const;
  const other = new Store(f.database);
  t.after(() => other.close());
  const absent: TransactionGuard = { id:'g3b:producer-absence', absent:true };
  const guards = sources.map(([name, result]) => {
    const prepared = delivered<{guards: TransactionGuard[]}>(result);
    assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(absent)), `${name} retained the producer's absence`);
    return { name, guards:prepared.guards };
  });
  const snapshot = await f.store.snapshot(join(f.root, 'absence-template'));
  const path = join(f.root, 'absence-control.sqlite');
  copyFileSync(snapshot.path, path);
  const control = new Store(path);
  try {
    for (const prepared of guards) {
      const writes = [0,1].map(i => ({id:`g3b:${prepared.name}:${i}`,kind:'test-output',expected:0,value:{i}}));
      delivered(writeGuarded(control, {unit:'F4',target:f.project,writes,guards:prepared.guards}));
      for (const write of writes) assert.ok(control.get(write.id));
    }
  } finally { control.close(); }
  other.write({id:absent.id,kind:'dependency',expected:0,value:{appeared:true}});
  const before = f.store.events(0, Number.MAX_SAFE_INTEGER).length;
  for (const prepared of guards) {
    const writes = [0,1].map(i => ({id:`g3b:${prepared.name}:${i}`,kind:'test-output',expected:0,value:{i}}));
    const transaction = transactionForTests(f.store) as ReturnType<typeof transactionForTests> & {protectedHeads():TransactionGuard[]};
    transaction.add({writes, guards:prepared.guards});
    const transactionGuards = transaction.protectedHeads();
    assert.ok(transactionGuards.some(guard => canonical(guard) === canonical(absent)));
    const refusal = refusedAs(writeGuarded(f.store,{unit:'F4',target:f.project,writes:[...transaction.writes.values()],guards:transactionGuards}), 'input_stale');
    assert.equal(refusal.at.target, absent.id);
    for (const write of writes) assert.equal(f.store.get(write.id), null, 'no member of the batch was committed');
  }
  assert.equal(f.store.events(0, Number.MAX_SAFE_INTEGER).length, before);
});

test("OM layer preparation guards its exact producer outputs without a research gate and rolls back a stale batch", async t => {
  const f = committedFrameFixture(t);
  const request = { project: "garden", level: 2 as const, graph: f.request.graph, layer: f.request.layer! };
  const own = [request.graph, request.layer, reference(f.store.get("graph-layer:garden:1")!), f.request.frame!];
  const gate = Refinement.prototype.gate;
  let calls = 0;
  Refinement.prototype.gate = function(...args) { calls++; return gate.apply(this, args); };
  try {
    const prepared = delivered(prepareLayerAcceptance(f.store, request));
    assert.equal(prepared.producer, "om");
    assert.deepEqual(prepared.guards.map(canonical).sort(), own.map(canonical).sort());
    assert.equal(calls, 0);
    const writes = [0, 1].map(i => ({ id: `g3b:layer:${i}`, kind: "test-output", expected: 0, value: { i } }));
    const snapshot = await f.store.snapshot(join(f.database + "-control"));
    const path = f.database + "-control.sqlite";
    copyFileSync(snapshot.path, path);
    const control = new Store(path);
    try {
      delivered(writeGuarded(control, { unit: "F4", target: "garden", writes, guards: prepared.guards }));
      for (const write of writes) assert.ok(control.get(write.id));
    } finally { control.close(); }
    const other = new Store(f.database), dependency = f.request.frame!;
    try {
      const current = other.get(dependency.id)!;
      other.write({ id: current.id, kind: current.kind, expected: current.revision, value: current.value });
    } finally { other.close(); }
    const before = f.store.events(0, Number.MAX_SAFE_INTEGER);
    const transaction = transactionForTests(f.store) as ReturnType<typeof transactionForTests> & { protectedHeads(): TransactionGuard[] };
    transaction.add({ writes, guards: prepared.guards });
    const failure = writeGuarded(f.store, { unit: "F4", target: "garden", writes: [...transaction.writes.values()], guards: transaction.protectedHeads() });
    assert.equal(refusedAs(failure, "input_stale").at.target, dependency.id);
    for (const write of writes) assert.equal(f.store.get(write.id), null);
    assert.equal(refusedAs(prepareLayerAcceptance(f.store, request), "input_stale").at.target, dependency.id);
    assert.deepEqual(f.store.events(0, Number.MAX_SAFE_INTEGER), before);
    assert.equal(calls, 0);
  } finally { Refinement.prototype.gate = gate; }
});

test("horizon and frame head checks use the actual view and active PF4 observations", async t => {
  const { f, req } = await storedHorizonFixture(t);
  const saved = delivered(writeHorizon(f.store, req));
  const basis = {project:f.project,graph:req.graph,horizon:reference(saved.gate)};
  const id = req.available[producer]![data]!.id, original = f.store.get(id)!;
  const view = (head: Revision | null | Error | undefined) => new Proxy(f.store, {get(target, key) {
    if (key === 'get') return (key: string, revision?: number) => {
      if (key === id && revision === undefined && head !== undefined) {
        if (head instanceof Error) throw head;
        return head;
      }
      return target.get(key, revision);
    };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  const actions = [
    (store:Store) => prepareHorizon(store, req),
    (store:Store) => prepareHorizonBasis(store, basis),
    (store:Store) => prepareFrame(store, frameRequestFor(f, reference(saved.gate), 2)),
  ];
  const writeOnly = storeView(f.store, {write:(writes, guards) => f.store.writeMany(writes, guards)});
  for (const action of actions) {
    const expected = action(f.store);
    assert.equal(expected.ok, true);
    for (const good of [writeOnly, pendingOverlay(f.store, []), view(undefined)]) assert.deepEqual(action(good), expected);
    for (const bad of [view(null), view({...original,revision:original.revision+1}),
      pendingOverlay(f.store,[{...original,revision:original.revision+1}])]) {
      const refusal = refusedAs<unknown>(action(bad), 'input_stale');
      assert.equal(refusal.at.target, id);
    }
    for (const error of [new TypeError('receipt read failed'), new EngineError('record_corrupt','receipt is corrupt')])
      assert.throws(() => action(view(error)), thrown => thrown === error);
    const heads:string[] = [];
    const previous = observeStore({begin:store => store===f.store ? {} : undefined,
      end:(_token,_store,method,_mode,key,revision) => { if(method==='get' && revision===undefined && key) heads.push(key); },
      write:() => assert.fail('preparation wrote'),untraced:() => {} });
    try {
      assert.deepEqual(action(writeOnly), expected);
      assert.ok(heads.includes(id), 'active PF4 captured the current receipt get');
    } finally { observeStore(previous); }
  }
});

test("TypeError and record_corrupt exceptions propagate cleanly without being masked as input_stale", async t => {
  const { f, req } = await storedHorizonFixture(t);

  assert.throws(() => {
    // Pass an object that throws TypeError during store.get
    const brokenStore = new Proxy(f.store, {
      get(target, prop) {
        if (prop === "get") {
          return () => { throw new TypeError("Low-level type error inside store.get"); };
        }
        return Reflect.get(target, prop);
      },
    });
    prepareHorizon(brokenStore as unknown as Store, req);
  }, (err: unknown) => {
    assert.ok(err instanceof TypeError);
    assert.equal((err as TypeError).message, "Low-level type error inside store.get");
    return true;
  });

  // Also verify for prepareFrame
  const horizon = acceptedHorizon(f.store, reference(f.layers[2]));
  const reqFrame = frameRequestFor(f, reference(horizon.gate), 2);
  assert.throws(() => {
    const brokenStore = new Proxy(f.store, {
      get(target, prop) {
        if (prop === "get") {
          return () => { throw new TypeError("Low-level type error inside prepareFrame"); };
        }
        return Reflect.get(target, prop);
      },
    });
    prepareFrame(brokenStore as unknown as Store, reqFrame);
  }, (err: unknown) => {
    assert.ok(err instanceof TypeError);
    return true;
  });
});

test("a graph-layer with real saved OM acceptance proves the horizon and guards its frame", async t => {
  const { f, req } = await storedHorizonFixture(t);
  assert.equal(req.refinement?.id, "graph-layer:garden:2");
  const prepared = delivered(prepareHorizon(f.store, req));
  for (const ref of [reference(f.layers[2]), reference(f.store.get("om-frame:garden:2")!)])
    assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(ref)), ref.id);
});


test('G3a+G3b native closure absence survives horizon and accepted frame preparation to atomic writes', t => {
  const absent = 'stage-prerequisite:frame', f = committedFrameFixture(t, absent);
  const candidates = [delivered(prepareHorizon(f.store, f.horizonRequest)), delivered(prepareFrame(f.store, f.request))];
  for (const prepared of candidates) assert.ok(prepared.guards.some(g => g.id === absent && 'absent' in g));
  const second = new Store(f.database);
  try { second.write({ id: absent, kind: 'prerequisite', expected: 0, value: {} }); }
  finally { second.close(); }
  const before = f.store.list().map(reference);
  for (const prepared of candidates) {
    const failure = writeGuarded(f.store, { unit: 'F4', target: 'garden', guards: prepared.guards,
      writes: [{ id: 'neighbor:frame-one', kind: 'neighbor', expected: 0, value: {} },
        { id: 'neighbor:frame-two', kind: 'neighbor', expected: 0, value: {} }] });
    assert.equal(refusedAs(failure, 'input_stale').at.target, absent);
    assert.deepEqual(f.store.list().map(reference), before);
    assert.equal(f.store.get('neighbor:frame-one'), null); assert.equal(f.store.get('neighbor:frame-two'), null);
  }
});

test('G3a+G3b closed reads decode no old answers and do not grow with tenfold foreign history', async t => {
  const f = committedFrameFixture(t);
  const oldBodies = new Set(['question', 'research-answer', 'research-assessment'].flatMap(kind =>
    f.store.list(kind).map(row => canonical(row.value))));
  assert.ok(oldBodies.size > 0);
  const measure = (database: string) => {
    const cold = new Store(database), parse = JSON.parse;
    let decoded = 0;
    JSON.parse = ((value: string, ...args: unknown[]) => {
      if (oldBodies.has(value)) decoded++;
      return Reflect.apply(parse, JSON, [value, ...args]);
    }) as typeof JSON.parse;
    try {
      const horizon = countReads(() => { delivered(prepareHorizon(cold, f.horizonRequest)); });
      const frame = countReads(() => { delivered(prepareFrame(cold, f.request)); });
      assert.equal(decoded, 0); assert.ok(horizon <= 13); assert.ok(frame <= 35);
      return { horizon, frame };
    } finally { JSON.parse = parse; cold.close(); }
  };
  // Both cold connections start with the same persisted proof cache; only foreign history differs.
  const saved = await f.store.snapshot(f.database + '.snapshot');
  const baseline = f.database + '.baseline', expanded = f.database + '.expanded';
  copyFileSync(saved.path, baseline); copyFileSync(saved.path, expanded);
  const before = measure(baseline), history = f.store.list().reduce((sum, row) => sum + row.revision, 0);
  const noise = new Store(expanded);
  try {
    for (let revision = 0; revision < 10; revision++) noise.writeMany(Array.from({ length: history }, (_, index) => ({
      id: `other-project:history:${index}`, kind: 'unrelated', expected: revision, value: { project: 'other-project', revision },
    })));
  } finally { noise.close(); }
  assert.deepEqual(measure(expanded), before);
});
