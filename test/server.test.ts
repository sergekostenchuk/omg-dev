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

test("H2 owner endpoints keep a separate trust boundary: exchange, cookie, Origin and revocation", async t => {
  const root = mkdtempSync(join(tmpdir(), "omg-server-owner-")); const store = new Store(join(root, "state.sqlite"));
  const engine = new ProductEngine(store); const server = createProductServer(engine);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`; const token = server.accessToken;
  await (await fetch(`${url}/api/command`, { method: "POST", headers: { "Content-Type": "application/json", "X-OMG-Token": token },
    body: JSON.stringify({ type: "create-project", project: "local", title: "Local product" }) })).json();
  const origin = { Origin: url };
  const owner = (path: string, init: RequestInit = {}) =>
    fetch(`${url}/api/owner/${path}`, { method: "POST", ...init,
      headers: { "X-OMG-Token": token, "Content-Type": "application/json", ...origin, ...(init.headers ?? {}) } });
  // The exchange needs the general token AND the exact Origin AND a valid invitation.
  const noToken = await fetch(`${url}/api/owner/session`, { method: "POST", headers: { "Content-Type": "application/json", ...origin },
    body: JSON.stringify({ project: "local", invitation: "x.y" }) });
  assert.equal(noToken.status, 403); assert.equal((await noToken.json()).error, "session_forbidden");
  const noOrigin = await fetch(`${url}/api/owner/session`, { method: "POST", headers: { "Content-Type": "application/json", "X-OMG-Token": token },
    body: JSON.stringify({ project: "local", invitation: "x.y" }) });
  assert.equal(noOrigin.status, 403); assert.equal((await noOrigin.json()).error, "origin_forbidden");
  const foreign = await fetch(`${url}/api/owner/session`, { method: "POST", headers: { "Content-Type": "application/json", "X-OMG-Token": token, Origin: "https://unrelated.example" },
    body: JSON.stringify({ project: "local", invitation: "x.y" }) });
  assert.equal(foreign.status, 403);
  const badInvite = await owner("session", { body: JSON.stringify({ project: "local", invitation: "bad" }) });
  assert.equal(badInvite.status, 403); assert.equal((await badInvite.json()).error, "owner_invitation_invalid");
  // The CLI surface issues the invitation; HTTP cannot mint one.
  const minted = engine.ownerInvitation("local");
  assert.equal(minted.ok, true); if (!minted.ok) return;
  const exchanged = await owner("session", { body: JSON.stringify({ project: "local", invitation: minted.value.invitation }) });
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  const cookie = exchanged.headers.get("set-cookie") ?? "";
  assert.match(cookie, /omg-owner=[a-f0-9]{64}/); assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Path=\/api\/owner/); assert.equal(cookie.includes("Secure"), false);
  const bearer = /omg-owner=([a-f0-9]{64})/.exec(cookie)![1]!;
  const spent = await owner("session", { body: JSON.stringify({ project: "local", invitation: minted.value.invitation }) });
  assert.equal(spent.status, 403); assert.equal((await spent.json()).error, "owner_invitation_spent");
  // Owner endpoints need the bearer cookie — the general token alone is no owner authority.
  const noCookie = await owner("decision", { body: JSON.stringify({ project: "local", routes: { id: "om-routes:local:x", revision: 1, hash: "0".repeat(64) }, gap: { id: "om-gap:local:x", revision: 1, hash: "0".repeat(64) }, value: "JSON", basis: "b" }) });
  assert.equal(noCookie.status, 403); assert.equal((await noCookie.json()).error, "owner_session_missing");
  const forgedBearer = await owner("decision", { headers: { Cookie: `omg-owner=${"0".repeat(64)}` },
    body: JSON.stringify({ project: "local", routes: { id: "x", revision: 1, hash: "0".repeat(64) }, gap: { id: "y", revision: 1, hash: "0".repeat(64) }, value: "JSON", basis: "b" }) });
  assert.equal(forgedBearer.status, 403); assert.equal((await forgedBearer.json()).error, "owner_session_missing");
  const noOwnerOrigin = await fetch(`${url}/api/owner/decision`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-OMG-Token": token, Cookie: `omg-owner=${bearer}` },
    body: JSON.stringify({}) });
  assert.equal(noOwnerOrigin.status, 403); assert.equal((await noOwnerOrigin.json()).error, "origin_forbidden");
  // With a live cookie the request reaches the producer — the absent M6 route is refused by the common reader.
  const decision = await owner("decision", { headers: { Cookie: `omg-owner=${bearer}` },
    body: JSON.stringify({ project: "local", routes: { id: "om-routes:local:absent", revision: 1, hash: "0".repeat(64) },
      gap: { id: "om-gap:local:absent", revision: 1, hash: "0".repeat(64) }, value: "JSON", basis: "b" }) });
  assert.equal(decision.status, 400); assert.equal((await decision.json()).error, "record_missing");
  const get = await fetch(`${url}/api/owner/decision`, { headers: { "X-OMG-Token": token, ...origin, Cookie: `omg-owner=${bearer}` } });
  assert.equal(get.status, 400); assert.equal((await get.json()).error, "owner_request_invalid");
  const logout = await owner("logout", { headers: { Cookie: `omg-owner=${bearer}` }, body: "{}" });
  assert.equal(logout.status, 200, await logout.clone().text());
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
  const after = await owner("decision", { headers: { Cookie: `omg-owner=${bearer}` }, body: JSON.stringify({ project: "local", routes: { id: "om-routes:local:absent", revision: 1, hash: "0".repeat(64) }, gap: { id: "om-gap:local:absent", revision: 1, hash: "0".repeat(64) }, value: "JSON", basis: "b" }) });
  assert.equal(after.status, 403); assert.equal((await after.json()).error, "owner_session_missing");
});
