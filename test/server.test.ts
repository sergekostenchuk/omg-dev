import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { createProductServer } from "../src/server.js";

test("local API rejects foreign sessions/origins and persists a genuine process-backed chat response", async t => {
  const root = mkdtempSync(join(tmpdir(), "omg-server-")); const store = new Store(join(root, "state.sqlite"));
  const engine = new ProductEngine(store); const server = createProductServer(engine);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const html = await (await fetch(url)).text(); const token = server.accessToken;
  assert.equal(html.includes(token), false);
  assert.equal((await fetch(`${url}/api/projects`)).status, 403);
  assert.equal((await fetch(`${url}/api/projects`, { headers: { "X-OMG-Token": token, Origin: "https://unrelated.example" } })).status, 403);
  const command = async (value: unknown) => {
    const response = await fetch(`${url}/api/command`, { method: "POST", headers: { "Content-Type": "application/json", "X-OMG-Token": token }, body: JSON.stringify(value) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  await command({ type: "create-project", project: "local", title: "Local product" });
  const program = join(root, "agent.mjs");
  writeFileSync(program, `import {readFileSync} from 'node:fs'; const r=JSON.parse(readFileSync(0,'utf8')); console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,text:'A real response from the selected local process'}));`);
  await command({ type: "configure", project: "local", expected: 0, environment: { workspace: root,
    implementer: { actor: "worker", model: "local-test", effort: "high", command: { executable: process.execPath, args: [program] } },
    reviewer: { actor: "reviewer", model: "local-review", effort: "high", command: { executable: process.execPath, args: [program] } },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 3000 } });
  const response = await fetch(`${url}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", "X-OMG-Token": token }, body: JSON.stringify({ project: "local", message: "Explain the current state" }) });
  const turn = await response.json() as { value: { status: string; text: string } };
  assert.equal(turn.value.status, "completed"); assert.match(turn.value.text, /selected local process/);
  const read = await fetch(`${url}/api/project?id=local`, { headers: { "X-OMG-Token": token } });
  const view = await read.json() as { chat: unknown[] }; assert.equal(view.chat.length, 1);
});
