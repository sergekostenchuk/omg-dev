import { resolve } from "node:path";
import { Store } from "./storage/store.js";
import { restoreSnapshot } from "./storage/snapshots.js";
import { EngineError } from "./errors.js";
import { readFileSync } from "node:fs";
import { reference } from "./pipeline/contracts.js";
import type { OmResult } from "./om/refusal.js";

function closeOwnerSession(store: Store, sessions: { revoke(bearer: unknown): OmResult<unknown> }, bearer: string | null): void {
  try {
    if (bearer !== null) {
      const closed = sessions.revoke(bearer);
      if (!closed.ok) throw new EngineError(closed.refusal.code, closed.refusal.message, closed.refusal.at);
    }
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw new EngineError("owner_session_cleanup_failed", "The owner session could not be closed");
  } finally { store.close(); }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, database = ".omg/state.sqlite", directory = ".omg/backups"] = args;
  // PR1 (№2943): the probe reads only the frozen snapshot it is given and copies it first; it never opens the default database.
  if (command === "probe") { const { probeCommand } = await import("./om/probe.js"); process.exitCode = await probeCommand(args.slice(1)); return; }
  if (command === "serve") {
    const [{ ProductEngine }, { createProductServer }] = await Promise.all([
      import("./product/engine.js"), import("./server.js")]);
    const store = new Store(resolve(database)); const server = createProductServer(new ProductEngine(store));
    const port = Number(args[2] ?? 4318);
    server.listen(port, "127.0.0.1", () => console.log(`OMG: http://127.0.0.1:${(server.address() as { port: number }).port}/#token=${server.accessToken}`));
    const close = () => server.close(() => { store.close(); process.exit(0); });
    process.once("SIGTERM", close); process.once("SIGINT", close); return;
  }
  if (command === "restore") {
    console.log(JSON.stringify(restoreSnapshot(directory, database))); return;
  }
  // Only these local owner doors mint scoped authority. JSON commands and
  // HTTP can name a decision, but cannot supply or mint its authority.
  if (command === 'owner-final-acceptance' || command === 'owner-final-condition') {
    const { parseCommand } = await import('./product/commands.js');
    const { FinalAcceptanceSessions, issueFinalAcceptanceInvitation, acceptDiscoveryFinal,
      ConditionChoiceSessions, issueConditionChoiceInvitation, resolveDiscoveryCondition } = await import('./product/owner-authority.js');
    const { provenAcceptanceGrounds, provenAcceptanceMode, readAcceptedDiscoveryManifestAt } = await import('./discovery/discovery-acceptance.js');
    const { discoveryDecisionOutput, discoveryConditionOutput } = await import('./product/engine.js');
    const store = new Store(resolve(database));
    const sessions = command === 'owner-final-acceptance' ? new FinalAcceptanceSessions(store) : new ConditionChoiceSessions(store);
    let bearer: string | null = null;
    let output: unknown;
    try {
      let input: unknown;
      try { input = JSON.parse(readFileSync(0, 'utf8')); }
      catch { throw new EngineError('command_invalid', 'The owner door requires valid JSON'); }
      const request = parseCommand(input);
      if (command === 'owner-final-acceptance' && request.type === 'discovery-final-decision') {
        const grounds = await provenAcceptanceGrounds(store, request.project, request.assessment);
        const mode = provenAcceptanceMode(store, request.project);
        const scope = { projectId: request.project, draft: grounds.draft, paid: grounds.paid, assessment: grounds.assessment,
          mode: mode.ref, decision: request.decision, reason: request.reason };
        const issued = await issueFinalAcceptanceInvitation(store, scope);
        if (!issued.ok) throw new EngineError(issued.refusal.code, issued.refusal.message);
        const login = sessions.exchange({ projectId: request.project, invitation: issued.value.invitation });
        if (!login.ok) throw new EngineError(login.refusal.code, login.refusal.message);
        bearer = login.value.bearer;
        const result = await acceptDiscoveryFinal(store, { projectId: request.project, assessment: request.assessment,
          decision: request.decision, reason: request.reason }, sessions.authority(bearer));
        output = discoveryDecisionOutput(result);
      } else if (command === 'owner-final-condition' && request.type === 'discovery-final-condition' && 'optionId' in request) {
        const accepted = await readAcceptedDiscoveryManifestAt(store, request.project, request.manifest);
        const scope = { projectId: request.project, predecessor: reference(accepted.manifest), bundle: reference(accepted.bundle),
          conditionId: request.conditionId, optionId: request.optionId, reason: request.reason };
        const issued = await issueConditionChoiceInvitation(store, scope);
        if (!issued.ok) throw new EngineError(issued.refusal.code, issued.refusal.message);
        const login = sessions.exchange({ projectId: request.project, invitation: issued.value.invitation });
        if (!login.ok) throw new EngineError(login.refusal.code, login.refusal.message);
        bearer = login.value.bearer;
        output = discoveryConditionOutput(await resolveDiscoveryCondition(store,
          { projectId: request.project, manifest: request.manifest, conditionId: request.conditionId,
            optionId: request.optionId, reason: request.reason }, sessions.authority(bearer)));
      } else throw new EngineError('command_invalid', 'The owner door requires its matching scoped command');
    } finally {
      closeOwnerSession(store, sessions, bearer);
    }
    console.log(JSON.stringify(output));
    return;
  }
  // H2.0 (№2719): invitation issuance is CLI-only — `serve`, `command` and HTTP can never mint one. The secret reaches
  // the owner's terminal exactly once; the Store keeps only its hash inside the grant.
  if (command === "owner-invite") {
    const { issueOwnerInvitation } = await import("./product/owner-authority.js");
    const store = new Store(resolve(database));
    try {
      const minted = issueOwnerInvitation(store, { project: args[2] });
      if (!minted.ok) throw new EngineError(minted.refusal.code, minted.refusal.message);
      console.log(JSON.stringify(minted.value));
    } finally { store.close(); }
    return;
  }
  // OC1: this trusted local command owns the whole scoped invitation/session lifecycle. Neither secret nor bearer is
  // accepted as input or printed; the general command/HTTP route therefore has no credential to replay.
  if (command === "owner-discovery-choice") {
    const [{ DiscoveryChoiceSessions, issueDiscoveryChoiceInvitation }, { answerDiscoveryCondition,
      validateDiscoveryConditionRequest }] = await Promise.all([
      import("./product/owner-authority.js"), import("./discovery/discovery-decision.js")]);
    const store = new Store(resolve(database)); const sessions = new DiscoveryChoiceSessions(store);
    let bearer: string | null = null;
    let output: unknown;
    try {
      let request: unknown;
      try { request = JSON.parse(readFileSync(0, "utf8")); }
      catch { throw new EngineError("discovery_choice_invalid", "owner-discovery-choice reads one JSON request from stdin"); }
      const scoped = validateDiscoveryConditionRequest(store, request);
      const issued = issueDiscoveryChoiceInvitation(store, scoped);
      if (!issued.ok) throw new EngineError(issued.refusal.code, issued.refusal.message, issued.refusal.at);
      const project = scoped.project;
      const exchanged = sessions.exchange({ project, invitation: issued.value.invitation });
      if (!exchanged.ok) throw new EngineError(exchanged.refusal.code, exchanged.refusal.message, exchanged.refusal.at);
      bearer = exchanged.value.bearer;
      const authority = sessions.authority(bearer);
      if (!authority) throw new EngineError("owner_session_missing", "The scoped local session was not established");
      const outcome = answerDiscoveryCondition(store, scoped, authority);
      output = { decision: reference(outcome.decision), repeated: outcome.repeated, nextAction: outcome.nextAction };
    } finally {
      closeOwnerSession(store, sessions, bearer);
    }
    console.log(JSON.stringify(output));
    return;
  }
  // DR1a: the trusted local project-mode command owns the whole scoped invitation/session lifecycle exactly like
  // OC1 — no secret or bearer crosses stdin/stdout, so the general command/HTTP route has no credential to replay.
  if (command === "owner-project-mode") {
    const [{ ProjectModeSessions, issueProjectModeInvitation }, { setProjectMode,
      validateProjectModeRequest }] = await Promise.all([
      import("./product/owner-authority.js"), import("./product/project-mode.js")]);
    const store = new Store(resolve(database)); const sessions = new ProjectModeSessions(store);
    let bearer: string | null = null;
    let output: unknown;
    try {
      let request: unknown;
      try { request = JSON.parse(readFileSync(0, "utf8")); }
      catch { throw new EngineError("project_mode_invalid", "owner-project-mode reads one JSON request from stdin",
        { door: "owner-project-mode" }); }
      const scoped = validateProjectModeRequest(store, request);
      const issued = issueProjectModeInvitation(store, scoped);
      if (!issued.ok) throw new EngineError(issued.refusal.code, issued.refusal.message, issued.refusal.at);
      const exchanged = sessions.exchange({ project: scoped.project, invitation: issued.value.invitation });
      if (!exchanged.ok) throw new EngineError(exchanged.refusal.code, exchanged.refusal.message, exchanged.refusal.at);
      bearer = exchanged.value.bearer;
      const authority = sessions.authority(bearer);
      if (!authority) throw new EngineError("owner_session_missing", "The scoped local session was not established");
      const outcome = setProjectMode(store, scoped, authority);
      output = { record: reference(outcome.record), mode: outcome.record.value.mode, repeated: outcome.repeated };
    } finally {
      closeOwnerSession(store, sessions, bearer);
    }
    console.log(JSON.stringify(output));
    return;
  }
  // 4O.3: the trusted local variant-choice command owns the whole scoped invitation/session lifecycle exactly like OC1
  // and DR1a — no secret or bearer crosses stdin/stdout, so the general command/HTTP route has no credential to replay.
  if (command === "owner-variant-choice") {
    const [{ VariantChoiceSessions, issueVariantChoiceInvitation }, { answerVariantChoice },
      { decodeVariantChoiceScope }] = await Promise.all([
      import("./product/owner-authority.js"), import("./discovery/discovery-decision.js"),
      import("./discovery/variant-decision.js")]);
    const store = new Store(resolve(database)); const sessions = new VariantChoiceSessions(store);
    let bearer: string | null = null;
    let output: unknown;
    try {
      let request: unknown;
      try { request = JSON.parse(readFileSync(0, "utf8")); }
      catch { throw new EngineError("discovery_variant_invalid",
        "owner-variant-choice reads one JSON request from stdin", { door: "owner-variant-choice" }); }
      // The shared exact-shape decoder only names the scope; the invitation mint and the single answer producer prove it.
      const scope = decodeVariantChoiceScope(request);
      const issued = issueVariantChoiceInvitation(store, scope);
      if (!issued.ok) throw new EngineError(issued.refusal.code, issued.refusal.message, issued.refusal.at);
      const exchanged = sessions.exchange({ projectId: scope.projectId, invitation: issued.value.invitation });
      if (!exchanged.ok) throw new EngineError(exchanged.refusal.code, exchanged.refusal.message, exchanged.refusal.at);
      bearer = exchanged.value.bearer;
      const authority = sessions.authority(bearer);
      if (!authority) throw new EngineError("owner_session_missing", "The scoped local session was not established");
      const outcome = answerVariantChoice(store, scope, authority);
      output = { decision: reference(outcome.decision), state: reference(outcome.state), repeated: outcome.repeated };
    } finally {
      closeOwnerSession(store, sessions, bearer);
    }
    console.log(JSON.stringify(output));
    return;
  }
  if (!["init", "inspect", "backup", "command"].includes(command ?? "")) {
    throw new EngineError("invalid_command", "Usage: npm start -- init|inspect|backup|restore|owner-invite|owner-discovery-choice|owner-project-mode|owner-variant-choice|owner-final-acceptance|owner-final-condition|command [database] [backup-directory]; owner doors and command read JSON from stdin; probe --help");
  }
  const store = new Store(resolve(database));
  try {
    let out: unknown;
    if (command === "command") {
      const { ProductEngine } = await import("./product/engine.js");
      out = await new ProductEngine(store).execute(JSON.parse(readFileSync(0, "utf8")));
    } else {
      out = command === "backup" ? await store.snapshot(directory)
        : { databaseId: store.databaseId, entities: store.list() };
    }
    console.log(JSON.stringify(out));
  } finally { store.close(); }
}

main().catch(error => {
  const details = error instanceof EngineError && error.details && typeof error.details === "object"
    ? error.details as { door?: unknown } : undefined;
  const scopedOwnerError = ["owner-discovery-choice", "owner-project-mode", "owner-variant-choice"].includes(process.argv[2] ?? "")
    || details?.door === "owner-discovery-choice" || details?.door === "owner-project-mode"
    || details?.door === "owner-variant-choice";
  console.error(JSON.stringify({ error: error instanceof EngineError ? error.code : "internal_error", message: error.message,
    ...(error instanceof EngineError && scopedOwnerError ? { details: error.details,
      door: details?.door ?? (process.argv[2] === "owner-project-mode" ? "owner-project-mode"
        : process.argv[2] === "owner-variant-choice" ? "owner-variant-choice" : "stage-summary") } : {}) }));
  process.exitCode = 1;
});
