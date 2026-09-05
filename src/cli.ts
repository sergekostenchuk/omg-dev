import { resolve } from "node:path";
import { Store } from "./storage/store.js";
import { restoreSnapshot } from "./storage/snapshots.js";
import { EngineError } from "./errors.js";
import { readFileSync } from "node:fs";
import { ProductEngine } from "./product/engine.js";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, database = ".omg/state.sqlite", directory = ".omg/backups"] = args;
  if (command === "restore") {
    console.log(JSON.stringify(restoreSnapshot(directory, database))); return;
  }
  if (!["init", "inspect", "backup", "command"].includes(command ?? "")) {
    throw new EngineError("invalid_command", "Usage: npm start -- init|inspect|backup|restore|command [database] [backup-directory]; command reads JSON from stdin");
  }
  const store = new Store(resolve(database));
  try {
    console.log(JSON.stringify(command === "command" ? new ProductEngine(store).execute(JSON.parse(readFileSync(0, "utf8")))
      : command === "backup" ? await store.snapshot(directory)
      : { databaseId: store.databaseId, entities: store.list() }));
  } finally { store.close(); }
}

main().catch(error => {
  console.error(JSON.stringify({ error: error instanceof EngineError ? error.code : "internal_error", message: error.message }));
  process.exitCode = 1;
});
