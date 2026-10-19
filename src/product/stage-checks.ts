import { discoveryBasisCatalogue } from '../discovery/discovery-outcome.js';
import {
  artifactFields, contractEraOf, discoveryOutcome, expectedRequirements,
  isBasisApplicationEra, isLegacyEra, orderedSpecs, readDraft, readExact, readStageArtifact, researchContract,
  stageFields, type UpstreamStage, UPSTREAM_STAGES,
} from "../discovery/projection-reader.js";
import { readOmInput } from '../om/input.js';
import { Store, type Revision, type TransactionGuard } from "../storage/store.js";
import { Pipeline } from "../pipeline/pipeline.js";
import { STAGES, reference, isRef, stageId, uniqueRefs, STAGE_CLOSURE_CONTRACT, type Stage, type StageArtifact, type StageValidators,
  type GateContext, type GateResult, type Ref, type Finding, type StageExternalCheck } from "../pipeline/contracts.js";
import { Discovery } from "../discovery/discovery.js";
import { GraphRepository, graphProjectionHandler } from "../graph/repository.js";
import { sourceExternalHandler, sourceIsCurrent, withSourceMemo, type Source } from "../evidence/evidence.js";
import { canonical, hashJson, type Json } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import type { Graph } from "../graph/model.js";
import { Environments, transactionGuardsCurrent, uniqueTransactionGuards } from "../runtime/environment.js";
import { Refinement, REFINEMENT_EXTERNAL_CHECKS } from "../graph/refinement.js";
import { buildL1 } from "../graph/builder.js";
import { projectGraph } from "../graph/project.js";
import { Compiler, type MachinePlan } from "../compiler/compiler.js";
import { EXECUTION_EXTERNAL_CHECKS, resultGate } from "../execution/result.js";
import { conceptApplicationFindings, preparationFindings, specificationApplicationFindings } from "../discovery/preparation-validation.js";
import { assertPilotBoundary } from "../discovery/reader-pilot.js";
import { readModelCallRecovery } from "../discovery/model-call-recovery.js";

/**
 * R2 (№2419): the stage checks, the era of a project and compile — one lower kit, so the OM modules that inspect a
 * stage, gate a layer or a refinement, or compile, never build a ProductEngine. ProductEngine holds these same
 * instances and delegates; this module never imports it. Its state is the Store or view it was given: no global
 * instance, no cache, and a traced or guarded view is never unwrapped. The validators are only bound here; the
 * Pipeline calls them after the kit is complete.
 */
/** Admission and reconstruction dispatch on the saved producer, independently of the next producer. */
export function stageResearchContract(stage: UpstreamStage, version: number, accepted: boolean) {
  return researchContract(stage, version, accepted);
}

export interface Project { id: string; title: string }
export interface StageContent { draft: Ref; fields: Record<string, Json>; graph: Ref | null }

function uniqueExternalChecks(checks: readonly StageExternalCheck[]): StageExternalCheck[] {
  return [...new Map(checks.map(check => [canonical(check), check])).values()];
}

export class StageChecks {
  readonly discovery: Discovery;
  readonly graphs: GraphRepository;
  readonly pipeline: Pipeline;
  readonly environments: Environments;
  readonly refinement: Refinement;
  readonly compiler: Compiler;
  constructor(readonly store: Store) {
    this.discovery = new Discovery(store); this.graphs = new GraphRepository(store, this.discovery);
    const validators = Object.fromEntries(STAGES.map(stage => [stage, (context: GateContext) => this.validateStage(stage, context)])) as unknown as StageValidators;
    // G2a: source/graph-projection; G2b: repository/environment/om-feasibility (refinement) and git-ancestry (execution).
    this.pipeline = new Pipeline(store, validators, {
      source: sourceExternalHandler,
      "graph-projection": graphProjectionHandler,
      ...REFINEMENT_EXTERNAL_CHECKS,
      ...EXECUTION_EXTERNAL_CHECKS,
    });
    this.environments = new Environments(store);
    this.refinement = new Refinement(store, this.discovery, this.graphs, this.environments, this.pipeline);
    this.compiler = new Compiler(store, this.pipeline, this.refinement, this.environments);
  }
  validateStage(stage: Stage, context: GateContext): GateResult {
    return withSourceMemo(() => this.#validateStage(stage, context));
  }
  #validateStage(stage: Stage, context: GateContext): GateResult {
    const rejected = (code: string, message: string): GateResult => ({ findings: [{ code, target: stage, message }], guards: [] });
    if (stage === "om-g2") {
      const content = context.content as { feasibility?: unknown } | null;
      if (!content || Object.keys(content).join(",") !== "feasibility" || !isRef(content.feasibility)) return rejected("feasibility_missing", "This stage requires a bound R3 result");
      return this.refinement.feasibilityGate(context.projectId, content.feasibility, context.accepted === true, context.accepted !== true);
    }
    if (stage === "compilation") {
      const content = context.content as { plan?: unknown } | null;
      if (!content || Object.keys(content).join(",") !== "plan" || !isRef(content.plan)) return rejected("plan_missing", "Compilation stage requires a generated plan");
      return this.compiler.gate(context.projectId, content.plan, context.accepted === true, context.accepted !== true);
    }
    if (stage === "execution") {
      const content = context.content as { result?: unknown } | null;
      if (!content || !isRef(content.result) || Object.keys(content).join(",") !== "result") return rejected("execution_result_missing", "Execution requires a complete committed result");
      return resultGate(this.store, context.projectId, content.result, context.accepted !== true);
    }
    if (!UPSTREAM_STAGES.includes(stage as UpstreamStage)) return rejected("stage_not_available", "This execution-stage module is not connected yet");
    const content = context.content as unknown as StageContent;
    if (!content || typeof content !== "object" || !isRef(content.draft) || !content.fields
      || !Object.hasOwn(content, "graph") || Object.keys(content).sort().join(",") !== "draft,fields,graph") return rejected("stage_content_invalid", "Stage content must bind a discovery result and its fields");
    const draft = readDraft(this.store, content.draft.id);
    if (!draft || draft.value.stage !== stage || draft.value.projectId !== context.projectId
      || canonical(draft.value.fields) !== canonical(content.fields)) return rejected("discovery_foreign", "Research does not belong to this stage or its fields changed");
    let outcome: ReturnType<typeof discoveryOutcome>;
    try { outcome = discoveryOutcome(this.store, draft); }
    catch (error) {
      if (!(error instanceof EngineError)) throw error;
      return rejected(error.code, error.message);
    }
    const result = this.discovery.gate(context.projectId, content.draft);
    result.findings.push(...outcome.findings); result.guards.push(...outcome.guards);
    const version = contractEraOf(draft.value);
    const legacy = isLegacyEra(version);
    const contract = researchContract(stage as UpstreamStage, version, context.accepted === true);
    if (!contract.supported)
      result.findings.push({ code: "research_contract_upgrade_required", target: stage, message: "New stage acceptance requires the enriched research contract; legacy history remains readable" });
    const specs = orderedSpecs(this.store, draft.value);
    const expected = expectedRequirements(stage as UpstreamStage, version, specs);
    if (!expected || canonical(specs) !== canonical(expected)) result.findings.push({ code: "research_contract_mismatch", target: stage, message: "Research questions do not match the stage's required fields" });
    if (!legacy && result.findings.length === 0) {
      const outcomes = this.store.get<{ projection: { artifacts: Graph['artifacts'] } }>(`graph-layer:${context.projectId}:1`);
      result.findings.push(...preparationFindings(stage, content.fields,
        name => stageFields(this.store, context.projectId, name),
        outcomes?.value.projection.artifacts.map(artifact => artifact.id) ?? []));
    }
    if (stage === 'concept' && isBasisApplicationEra(version)) {
      const source = context.inputs[0];
      try {
        requireCondition(source?.value.stage === 'discovery' && source.value.status === 'accepted',
          'basis_application_material_invalid',
          `[${stageId(context.projectId, 'discovery')}] The concept needs its exact accepted Discovery source`);
        const fields = artifactFields(source);
        requireCondition(fields !== null,
          'basis_application_material_invalid', `[${source.id}] Accepted Discovery fields are missing`);
        const catalogue = discoveryBasisCatalogue({ ref: reference(source), fields });
        result.findings.push(...conceptApplicationFindings(content.fields['conceptSections'] ?? null, catalogue));
        result.guards.push(reference(source));
      } catch (error) {
        if (!(error instanceof EngineError)) throw error;
        result.findings.push({ code: error.code, target: source?.id ?? stageId(context.projectId, 'discovery'),
          field: 'conceptSections', message: error.message });
      }
    }
    if (stage === 'specification' && isBasisApplicationEra(version)) {
      const operation = context.inputs[0];
      try {
        const conceptRef = operation?.value.inputs[0];
        requireCondition(operation?.value.stage === 'operation-map' && isRef(conceptRef)
          && conceptRef.id === stageId(context.projectId, 'concept'),
          'basis_application_material_invalid', '[concept] Specification needs its exact accepted concept');
        const concept = readStageArtifact<StageArtifact>(this.store, conceptRef.id, conceptRef.revision);
        requireCondition(concept?.kind === 'stage' && canonical(reference(concept)) === canonical(conceptRef)
          && concept.value.projectId === context.projectId && concept.value.stage === 'concept'
          && concept.value.status === 'accepted', 'basis_application_material_invalid',
          `[${conceptRef.id}] Specification lost its accepted concept`);
        const discoveryRef = concept.value.inputs[0];
        requireCondition(concept.value.inputs.length === 1 && isRef(discoveryRef)
          && discoveryRef.id === stageId(context.projectId, 'discovery'),
          'basis_application_material_invalid', `[${concept.id}] Concept needs its exact Discovery source`);
        const discovery = readStageArtifact<StageArtifact>(this.store, discoveryRef.id, discoveryRef.revision);
        requireCondition(discovery?.kind === 'stage' && canonical(reference(discovery)) === canonical(discoveryRef)
          && discovery.value.projectId === context.projectId && discovery.value.stage === 'discovery'
          && discovery.value.status === 'accepted', 'basis_application_material_invalid',
          `[${discoveryRef.id}] Specification lost its accepted Discovery source`);
        const discoveryFields = artifactFields(discovery), conceptFields = artifactFields(concept);
        requireCondition(discoveryFields !== null && conceptFields !== null,
          'basis_application_material_invalid', '[behaviorContracts] Accepted source fields are missing');
        const catalogue = discoveryBasisCatalogue({ ref: reference(discovery), fields: discoveryFields });
        result.findings.push(...specificationApplicationFindings(content.fields['behaviorContracts'] ?? null,
          conceptFields['conceptSections'] ?? null, catalogue));
        result.guards.push(reference(concept), reference(discovery));
      } catch (error) {
        if (!(error instanceof EngineError)) throw error;
        result.findings.push({ code: error.code, target: operation?.id ?? stageId(context.projectId, 'operation-map'),
          field: 'behaviorContracts', message: error.message });
      }
    }
    const prior = context.inputs[0];
    if (prior && !draft.value.inputs.some(input => input.id === prior.id && input.hash === prior.hash && input.revision === prior.revision)) result.findings.push({ code: "research_context_stale", target: stage, message: "Research must bind the accepted prerequisite used by this stage" });
    if (stage === "operation-map") {
      if (!isRef(content.graph)) result.findings.push({ code: "graph_missing", target: stage, message: "An operation map is required" });
      else { const graphResult = this.graphs.layerGate(context.projectId, 1, content.graph); result.findings.push(...graphResult.findings); result.guards.push(...graphResult.guards); }
      if (contract.checkMapDesign && result.findings.length === 0) {
        const graph = this.store.get<Graph>(`graph:${context.projectId}`)!;
        const initial = artifactFields(readStageArtifact<StageArtifact>(this.store, stageId(context.projectId, "discovery"))!);
        const concept = artifactFields(readStageArtifact<StageArtifact>(this.store, stageId(context.projectId, "concept"))!);
        try {
          const proposed = buildL1(graph.value.id, graph.value.title, content.fields['mapDesign'], initial!, concept!);
          if (canonical(projectGraph(graph.value, 1)) !== canonical(projectGraph(proposed, 1))) result.findings.push({ code: "map_design_drift", target: graph.id, message: "Stored L1 must match the researched design and accepted concept" });
        } catch (error) { result.findings.push({ code: "map_design_invalid", target: stage, message: error instanceof Error ? error.message : "Invalid researched map" }); }
      }
    } else if (content.graph !== null) result.findings.push({ code: "graph_binding_unexpected", target: stage, message: "This stage inherits its map through the accepted prerequisite" });
    if (stage === "features") {
      const specification = prior?.value.content as unknown as StageContent;
      const behavior = specification?.fields['behavior'];
      const graph = this.store.get<{ projection: { artifacts: Graph['artifacts'] } }>(`graph-layer:${context.projectId}:1`);
      const features = content.fields['features'];
      const covered = new Set<number>();
      if (!Array.isArray(features) || !Array.isArray(behavior) || !graph) result.findings.push({ code: "feature_binding_missing", target: stage, message: "Features require a specification and operation map" });
      else for (const raw of features) {
        const feature = raw as { title: string; outcome: string; requirements: number[] };
        if (!graph.value.projection.artifacts.some(artifact => artifact.id === feature.outcome)) result.findings.push({ code: "feature_outcome_missing", target: feature.title, field: "features", message: "Feature outcome must exist in the operation map" });
        for (const index of feature.requirements) {
          if (!Number.isSafeInteger(index) || index < 0 || index >= behavior.length) result.findings.push({ code: "feature_requirement_missing", target: feature.title, field: "features", message: "Feature refers to a nonexistent requirement" });
          else covered.add(index);
        }
      }
      if (Array.isArray(behavior) && covered.size !== behavior.length) result.findings.push({ code: "requirement_uncovered", target: stage, field: "features", message: "Every specified behavior needs a feature" });
      const layer = this.graphs.layerGate(context.projectId, 1); result.findings.push(...layer.findings); result.guards.push(...layer.guards);
    }
    if (!legacy && result.findings.length === 0) {
      const external: StageExternalCheck[] = [];
      for (const ref of uniqueRefs(result.guards)) {
        const source = this.store.get<Source>(ref.id, ref.revision);
        if (source?.kind === "source") {
          if (source.hash !== ref.hash || !sourceIsCurrent(source.value, ref)) {
            result.findings.push({ code: "external_source_changed", target: ref.id, message: "The declared external source changed or disappeared" });
          }
          external.push({ kind: "source", ref });
        }
      }
      if (stage === "operation-map" || stage === "features") {
        const layerRecord = this.store.get<{ projection?: ReturnType<typeof projectGraph>; layerProofs?: Array<{ level: number; hash: string }> }>(`graph-layer:${context.projectId}:1`);
        const proof = layerRecord?.value.layerProofs?.find(p => p.level === 1);
        const hash = proof?.hash ?? (layerRecord?.value.projection ? hashJson(layerRecord.value.projection) : null);
        if (hash) external.push({ kind: "graph-projection", level: 1, hash });
      }
      result.closure = {
        contract: STAGE_CLOSURE_CONTRACT,
        external: uniqueExternalChecks(external),
      };
    }
    return result;
  }
  project(id: string): Revision<Project> {
    const project = this.store.get<Project>(`project:${id}`);
    requireCondition(project && project.kind === "project", "project_missing", "Project does not exist"); return project;
  }
  /** Capture the absent dependency before resolving the project era. It belongs only to new production. */
  legacyRoute(project: string): { om: boolean; guards: TransactionGuard[] } {
    const guards: TransactionGuard[] = [{ id: `om-input:${project}`, absent: true }];
    return { om: this.omProject(project), guards };
  }
  legacyProductionGuards(project: string): TransactionGuard[] {
    const route = this.legacyRoute(project);
    if (route.om)
      throw new EngineError('legacy_route_closed', 'New legacy production is closed after the first OM input',
        { unit: 'product', target: `om-input:${project}` });
    return route.guards;
  }
  production<T>(project: string, guards: TransactionGuard[], produce: () => T): T {
    try { return produce(); }
    catch (error) {
      const id = `om-input:${project}`;
      if (error instanceof EngineError && error.code === 'input_stale'
        && guards.some(guard => guard.id === id && 'absent' in guard)
        && !transactionGuardsCurrent(this.store, [{ id, absent: true }]))
        throw new EngineError(error.code, error.message, { unit: 'product', target: id });
      throw error;
    }
  }
  planProductionGuards(project: string, planRef: Ref): TransactionGuard[] {
    const plan = this.store.get<MachinePlan>(planRef.id, planRef.revision);
    // The publisher still proves this exact plan. Only the declared producer address selects the route.
    return plan?.value?.feasibility?.id === `om-feasibility:${project}` ? []
      : this.legacyProductionGuards(project);
  }
  compile(project: string, extraGuards: TransactionGuard[] = []) {
    assertPilotBoundary(this.store, project, 'R3');
    this.project(project);
    const route = this.legacyRoute(project);
    const basis = this.store.get<StageArtifact>(stageId(project, 'om-g2'));
    const feasibility = (basis?.value?.content as unknown as { feasibility?: Ref } | undefined)?.feasibility;
    const guards = uniqueTransactionGuards([...extraGuards,
      ...(feasibility?.id === `om-feasibility:${project}` && basis ? [reference(basis)] : route.guards)]);
    // Core compile/accept keep their existing no-write repeats. The negative dependency is checked
    // only if this command actually creates a plan, publishes a stage, or accepts a draft.
    return this.production(project, guards, () => {
      const plan = this.compiler.compile(project, guards);
      const current = this.store.get<StageArtifact>(stageId(project, 'compilation'));
      if (current?.value.status === 'accepted' && (current.value.content as unknown as { plan?: Ref }).plan?.hash === plan.hash) return plan;
      const stage = this.compiler.publish(project, reference(plan), current?.revision ?? 0, guards);
      this.pipeline.accept(project, 'compilation', stage.revision, guards);
      return plan;
    });
  }
  /** The first B1 is an immutable era boundary, independent of current stage or layer readiness. */
  omProject(project: string): boolean {
    const id = `om-input:${project}`;
    const first = this.store.get(id, 1);
    if (first) {
      const checked = readOmInput(this.store, project, reference(first));
      if (!checked.ok) throw new EngineError(checked.refusal.code, checked.refusal.message, checked.refusal.at);
      return true;
    }
    // Provenance of a lost B1 is checked once at fsck/start/continue, never on this hot era read.
    return false;
  }
}

/* R2 (№2427): the reader of a legacy operation and its whole proof chain, moved unchanged from preparation-run so OM
 * reads it without the product layer above; begin/finish/recover stay there and call these same checks. */
export interface PreparationRun {projectId:string;status:'running'|'paused'|'accepted';phase:string;draft:Ref|null;plan:Ref|null;
  owner:{pid:number;started:string};error:string|null;code:string|null;findings:Finding[];calls:number}
export interface LegacyOperation {
 contract:'legacy-operation/v1'; projectId:string; operation:'prepare'|'repair'; token:string;
 basis:Ref; owner:{pid:number;started:string}; state:'active'|'released'; previous:Ref|null;
 release:null|{from:Ref;reason:'returned'|'failed'|'recovered';result:Ref|null;error:{code:string;message:string}|null;
  dispatch:TransactionGuard;calls:Ref[];parking:Ref|null};
}
export const legacyObject=(value:unknown):value is Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export const legacySame=(left:unknown,right:unknown)=>canonical(left)===canonical(right);
export function legacyFailure(project:string,code:string,message:string):never{
 throw new EngineError(code,message,{unit:'product',target:`legacy-operation:${project}`});
}
export function legacyExact(store:Store,project:string,ref:Ref,kind?:string):Revision<any>{
 if(!isRef(ref))legacyFailure(project,'legacy_operation_invalid','An exact operation source is required');
 const record=readExact(store,ref);
 if(!record||!legacyObject(record.value)||!legacySame(reference(record),ref)||hashJson(record.value)!==ref.hash||(kind&&record.kind!==kind))
  legacyFailure(project,'legacy_operation_invalid','An exact operation source is unavailable');
 return record;
}
function preparationResultShape(value:unknown):value is PreparationRun{
 return legacyObject(value)&&typeof value.projectId==='string'&&['running','paused','accepted'].includes(value.status)
  &&['R2','L3','R3','compilation'].includes(value.phase)&&(value.draft===null||isRef(value.draft))
  &&(value.plan===null||isRef(value.plan))&&legacyObject(value.owner)&&Number.isSafeInteger(value.owner.pid)&&value.owner.pid>0
  &&typeof value.owner.started==='string'&&value.owner.started.length>0&&(value.error===null||typeof value.error==='string')
  &&(value.code===null||typeof value.code==='string')&&Number.isSafeInteger(value.calls)&&value.calls>=0
  &&Array.isArray(value.findings)&&value.findings.every(item=>legacyObject(item)&&typeof item.code==='string'
   &&typeof item.target==='string'&&typeof item.message==='string'&&(item.field===undefined||typeof item.field==='string'));
}
// The release writer and historical reader use this same completion contract.
function checkedLegacyResult(store:Store,project:string,operation:LegacyOperation,proof:NonNullable<LegacyOperation['release']>):void{
 const failure=legacyObject(proof.error)&&typeof proof.error.code==='string'&&proof.error.code.length>0
  &&typeof proof.error.message==='string'&&proof.error.message.length>0;
 if(!(proof.reason==='returned'?isRef(proof.result)&&proof.error===null
  :proof.reason==='failed'?failure:proof.reason==='recovered'&&proof.result===null&&proof.error===null))
  legacyFailure(project,'legacy_operation_invalid','Release reason requires its saved result or failure');
 if(proof.result===null)return;
 const result=legacyExact(store,project,proof.result),value=result.value;
 if(operation.operation==='prepare'){
  if(result.kind!=='preparation-run'||result.id!==operation.basis.id||result.revision<=operation.basis.revision
   ||!preparationResultShape(value)||value.projectId!==project||!legacySame(value.owner,operation.owner)
   ||!['paused','accepted'].includes(value.status)
   ||(value.status==='accepted'?value.phase!=='compilation'||value.draft!==null||!isRef(value.plan)||value.error!==null||value.code!==null:value.plan!==null))
   legacyFailure(project,'legacy_operation_invalid','Release needs this preparation\'s complete terminal result');
  // A later invocation may have the same pid. Its result cannot finish this one:
  // the first terminal revision ends the preparation that began at basis.
  for(let revision=operation.basis.revision;revision<result.revision;revision++){
   const prior=store.get<PreparationRun>(result.id,revision);
   if(!prior||prior.kind!=='preparation-run'||hashJson(prior.value)!==prior.hash||!preparationResultShape(prior.value)
    ||prior.value.projectId!==project||prior.value.status!=='running'||!legacySame(prior.value.owner,operation.owner))
    legacyFailure(project,'legacy_operation_invalid','The result must end this exact preparation invocation');
  }
  if(value.draft&&legacyExact(store,project,value.draft,'discovery-draft').value.projectId!==project)
   legacyFailure(project,'legacy_operation_invalid','The preparation result has a foreign draft');
 }else{
  if(result.kind!=='plan-repair'||result.id!==`plan-repair:${hashJson(operation.basis)}`||value.projectId!==project
   ||!isRef(value.run)||!legacySame(value.run,operation.basis)||!isRef(value.defect)||!isRef(value.parked)
   ||![1,2].includes(value.level)||!['research','design','compile','reissued'].includes(value.phase)
   ||typeof value.draftId!=='string'||!value.draftId.trim()||!(value.plan===null||isRef(value.plan))
   ||!(value.error===null||typeof value.error==='string')||!legacySame(value.parked,proof.parking)
   ||(value.phase==='reissued'?!isRef(value.plan)||value.error!==null||value.level!==2:value.plan!==null))
   legacyFailure(project,'legacy_operation_invalid','Release needs this repair\'s complete saved result');
  const failed=legacyExact(store,project,operation.basis,'task-run'),defect=legacyExact(store,project,value.defect,'plan-defect');
  const parked=legacyExact(store,project,value.parked,'parked-candidate');
  if(defect.id!==`plan-defect:${hashJson(operation.basis)}`||defect.value.projectId!==project||!isRef(defect.value.run)
   ||!legacySame(defect.value.run,operation.basis)||!isRef(failed.value.plan)||!isRef(defect.value.plan)||!legacySame(defect.value.plan,failed.value.plan)
   ||!isRef(defect.value.parked)||!legacySame(defect.value.parked,value.parked)||parked.value.projectId!==project
   ||!isRef(parked.value.run)||!legacySame(parked.value.run,operation.basis)||parked.value.state!=='parked')
   legacyFailure(project,'legacy_operation_invalid','The repair result has foreign defect or parking grounds');
 }
 if(value.plan&&legacyExact(store,project,value.plan,'plan').value.projectId!==project)
  legacyFailure(project,'legacy_operation_invalid','The saved result has a foreign plan');
}
export function checkedLegacyOperation(store:Store,project:string,record:Revision<LegacyOperation>):Revision<LegacyOperation>{
 const v=record.value,id=`legacy-operation:${project}`;
 if(record.id!==id||record.kind!=='legacy-operation'||!legacyObject(v)||hashJson(v)!==record.hash
  ||v.contract!=='legacy-operation/v1'||v.projectId!==project||!['prepare','repair'].includes(v.operation)
  ||typeof v.token!=='string'||!v.token.trim()||!isRef(v.basis)||!legacyObject(v.owner)
  ||!Number.isSafeInteger(v.owner.pid)||v.owner.pid<=0||typeof v.owner.started!=='string'||!v.owner.started
  ||!['active','released'].includes(v.state)||!Object.hasOwn(v,'previous')||!Object.hasOwn(v,'release'))
  legacyFailure(project,'legacy_operation_invalid','The operation marker has an invalid contract');
 const source=legacyExact(store,project,v.basis,v.operation==='prepare'?'preparation-run':'task-run');
 if(source.value?.projectId!==project||(v.operation==='prepare'
  ?source.id!==`preparation-run:${project}`||source.value.status!=='running'||!legacyObject(source.value.owner)||!legacySame(source.value.owner,v.owner)
  :source.value.state!=='needs_plan'))legacyFailure(project,'legacy_operation_invalid','The operation has a foreign starting basis');
 const active=v.state==='active'?record:legacyExact(store,project,v.release?.from as Ref,'legacy-operation') as Revision<LegacyOperation>;
 if(v.state==='released'){
  const proof=v.release;
  if(!legacyObject(proof)||!isRef(proof.from)||proof.from.id!==id||proof.from.revision!==record.revision-1
   ||active.value.state!=='active'||!legacySame({...active.value,state:'released',release:proof},v)
   ||!['returned','failed','recovered'].includes(proof.reason)||!(proof.result===null||isRef(proof.result))
   ||!(proof.parking===null||isRef(proof.parking))||!Array.isArray(proof.calls)||!proof.calls.every(isRef)
   ||!(proof.error===null||legacyObject(proof.error)&&typeof proof.error.code==='string'&&typeof proof.error.message==='string'))
   legacyFailure(project,'legacy_operation_invalid','Release must retain the exact completed ownership');
  if(!legacyObject(proof.dispatch))legacyFailure(project,'legacy_operation_invalid','Release has no dispatch boundary');
  try{uniqueTransactionGuards([proof.dispatch]);}
  catch{legacyFailure(project,'legacy_operation_invalid','Release has an invalid dispatch boundary');}
  if(proof.dispatch.id!==`project-dispatch:${hashJson(project)}`
   ||new Set(proof.calls.map(ref=>ref.id)).size!==proof.calls.length)
   legacyFailure(project,'legacy_operation_invalid','Release must retain its dispatch boundary and complete call identities');
  if(!('absent' in proof.dispatch))legacyExact(store,project,proof.dispatch,'project-dispatch');
  for(const ref of proof.calls){const call=legacyExact(store,project,ref,'model-call');
   if(call.value.projectId!==project||!['succeeded','failed'].includes(call.value.status)||!Number.isFinite(call.value.finishedAt))
    legacyFailure(project,'legacy_operation_invalid','A released operation cannot retain unfinished calls');
   if(call.value.error==='process_lost'&&call.value.execution)readModelCallRecovery(store,project,ref);
  }
  checkedLegacyResult(store,project,v,proof);
  if(proof.parking){const parked=legacyExact(store,project,proof.parking,'parked-candidate');
   if(v.operation!=='repair'||parked.value.projectId!==project||parked.value.state!=='parked'||!isRef(parked.value.run)||!legacySame(parked.value.run,v.basis))
    legacyFailure(project,'legacy_operation_invalid','Release has a foreign parking result');
  }
 }
 if(active.value.release!==null||active.value.state!=='active')legacyFailure(project,'legacy_operation_invalid','Ownership must begin active');
 if(active.revision===1){if(active.value.previous!==null)legacyFailure(project,'legacy_operation_invalid','Initial ownership has no predecessor');}
 else{
  if(!isRef(active.value.previous)||active.value.previous.id!==id||active.value.previous.revision!==active.revision-1)
   legacyFailure(project,'legacy_operation_invalid','Ownership must follow its exact released predecessor');
  const prior=legacyExact(store,project,active.value.previous,'legacy-operation') as Revision<LegacyOperation>;
  if(prior.value.state!=='released'||prior.value.token===v.token)legacyFailure(project,'legacy_operation_invalid','Ownership cannot replace active or reuse its token');
  checkedLegacyOperation(store,project,prior);
 }
 return record;
}
export function readLegacyOperation(store:Store,project:string):Revision<LegacyOperation>|null{
 if(!store||typeof store.get!=='function'||typeof project!=='string'||!project.trim())
  throw new EngineError('legacy_operation_invalid','A project and Store are required');
 const record=store.get<LegacyOperation>(`legacy-operation:${project}`);
 return record?checkedLegacyOperation(store,project,record):null;
}
