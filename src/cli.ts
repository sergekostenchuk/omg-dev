import { resolve } from "node:path";
import { Store } from "./storage/store.js";
import { restoreSnapshot } from "./storage/snapshots.js";
import { EngineError } from "./errors.js";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, database = ".omg/state.sqlite", directory = ".omg/backups"] = args;
  if (command === "restore") {
    console.log(JSON.stringify(restoreSnapshot(directory, database))); return;
  }
  if (!["init", "inspect", "backup"].includes(command ?? "")) {
    throw new EngineError("invalid_command", "Usage: npm start -- init|inspect|backup|restore [database] [backup-directory]");
  }
  const store = new Store(resolve(database));
  try {
    console.log(JSON.stringify(command === "backup" ? await store.snapshot(directory)
      : { databaseId: store.databaseId, entities: store.list() }));
  } finally { store.close(); }
}

main().catch(error => {
  console.error(JSON.stringify({ error: error instanceof EngineError ? error.code : "internal_error", message: error.message }));
  process.exitCode = 1;
});
