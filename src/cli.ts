import { resolve } from "node:path";
import { Store } from "./storage/store.js";
import { restoreSnapshot } from "./storage/snapshots.js";
import { EngineError } from "./errors.js";
import { readFileSync } from "node:fs";
import { ProductEngine } from "./product/engine.js";
import { createProductServer } from "./server.js";
import { DiscoveryChoiceSessions, issueDiscoveryChoiceInvitation, issueOwnerInvitation } from "./product/owner-authority.js";
import { probeCommand } from "./om/probe.js";
import { answerDiscoveryCondition, validateDiscoveryConditionRequest } from "./discovery/discovery-decision.js";
import { reference } from "./pipeline/contracts.js";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, database = ".omg/state.sqlite", directory = ".omg/backups"] = args;
  // PR1 (№2943): the probe reads only the frozen snapshot it is given and copies it first; it never opens the default database.
  if (command === "probe") { process.exitCode = await probeCommand(args.slice(1)); return; }
  if (command === "serve") {
    const store = new Store(resolve(database)); const server = createProductServer(new ProductEngine(store));
    const port = Number(args[2] ?? 4318);
    server.listen(port, "127.0.0.1", () => console.log(`OMG: http://127.0.0.1:${(server.address() as { port: number }).port}/#token=${server.accessToken}`));
    const close = () => server.close(() => { store.close(); process.exit(0); });
    process.once("SIGTERM", close); process.once("SIGINT", close); return;
  }
  if (command === "restore") {
    console.log(JSON.stringify(restoreSnapshot(directory, database))); return;
  }
  // H2.0 (№2719): invitation issuance is CLI-only — `serve`, `command` and HTTP can never mint one. The secret reaches
  // the owner's terminal exactly once; the Store keeps only its hash inside the grant.
  if (command === "owner-invite") {
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
    const store = new Store(resolve(database)); const sessions = new DiscoveryChoiceSessions(store);
    let bearer: string | null = null;
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
      console.log(JSON.stringify({ decision: reference(outcome.decision), repeated: outcome.repeated,
        nextAction: outcome.nextAction }));
    } finally {
      if (bearer && sessions.authority(bearer)) sessions.revoke(bearer);
      store.close();
    }
    return;
  }
  if (!["init", "inspect", "backup", "command"].includes(command ?? "")) {
    throw new EngineError("invalid_command", "Usage: npm start -- init|inspect|backup|restore|owner-invite|owner-discovery-choice|command [database] [backup-directory]; choice/command read JSON from stdin; probe --help");
  }
  const store = new Store(resolve(database));
  try {
    console.log(JSON.stringify(command === "command" ? await new ProductEngine(store).execute(JSON.parse(readFileSync(0, "utf8")))
      : command === "backup" ? await store.snapshot(directory)
      : { databaseId: store.databaseId, entities: store.list() }));
  } finally { store.close(); }
}

main().catch(error => {
  const details = error instanceof EngineError && error.details && typeof error.details === "object"
    ? error.details as { door?: unknown } : undefined;
  const discoveryChoiceError = process.argv[2] === "owner-discovery-choice"
    || details?.door === "owner-discovery-choice";
  console.error(JSON.stringify({ error: error instanceof EngineError ? error.code : "internal_error", message: error.message,
    ...(error instanceof EngineError && discoveryChoiceError ? { details: error.details,
      door: details?.door ?? "stage-summary" } : {}) }));
  process.exitCode = 1;
});
