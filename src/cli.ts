import { resolve } from "node:path";
import { Store } from "./storage/store.js";
import { restoreSnapshot } from "./storage/snapshots.js";
import { EngineError } from "./errors.js";
import { readFileSync } from "node:fs";
import { ProductEngine } from "./product/engine.js";
import { createProductServer } from "./server.js";
import { issueOwnerInvitation } from "./product/owner-authority.js";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, database = ".omg/state.sqlite", directory = ".omg/backups"] = args;
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
  if (!["init", "inspect", "backup", "command"].includes(command ?? "")) {
    throw new EngineError("invalid_command", "Usage: npm start -- init|inspect|backup|restore|owner-invite|command [database] [backup-directory]; command reads JSON from stdin");
  }
  const store = new Store(resolve(database));
  try {
    console.log(JSON.stringify(command === "command" ? await new ProductEngine(store).execute(JSON.parse(readFileSync(0, "utf8")))
      : command === "backup" ? await store.snapshot(directory)
      : { databaseId: store.databaseId, entities: store.list() }));
  } finally { store.close(); }
}

main().catch(error => {
  console.error(JSON.stringify({ error: error instanceof EngineError ? error.code : "internal_error", message: error.message }));
  process.exitCode = 1;
});
