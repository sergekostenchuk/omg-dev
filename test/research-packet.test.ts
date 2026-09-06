import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { ResearchSources } from "../src/discovery/research-sources.js";
import { researchHistory } from "../src/discovery/research-history.js";
import { reference } from "../src/pipeline/contracts.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import type { ResearchTurn } from "../src/discovery/research-model.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-research-packet-"));
  const store = new Store(join(root, "state.sqlite")); const engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  engine.execute({ type: "create-project", project: "p", title: "Packet fixture" });
  return { root, store, engine };
}

test("file inventory sends identities instead of repeated code, with exact selectable content and stale-source refusal", t => {
  const { root, store, engine } = fixture(t);
  const text = "Header that used to recur in every request.\n".repeat(100) + "EXACT-END-BOUNDARY";
  writeFileSync(join(root, "entry.ts"), text);
  const file = engine.discovery.evidence.file("p", "entry", root, "entry.ts", "text/plain", 0);
  const owner = engine.discovery.evidence.document("p", "owner", "Preserve the selected user's requirements.", "text/plain", 0);
  const sources = new ResearchSources(store, "p", root); const inventory = sources.inventory();
  const entry = inventory.sources.find(item => item.ref.id === file.id)!;
  assert.equal(entry.excerpt, ""); assert.equal(entry.truncated, true);
  assert.deepEqual(entry.ref, reference(file)); assert.equal(entry.length, text.length);
  assert.equal(inventory.sources.find(item => item.ref.id === owner.id)!.excerpt, owner.value.content);
  assert.equal(sources.excerpt(entry.ref, text.length - 18, text.length).value, text.slice(-18));
  assert.equal(sources.search("EXACT-END-BOUNDARY").sources[0]!.source.hash, file.hash);
  writeFileSync(join(root, "entry.ts"), "Changed actual bytes");
  assert.ok(!sources.inventory().sources.some(item => item.ref.id === file.id));
  assert.throws(() => sources.excerpt(entry.ref, 0, 10), { code: "source_stale" });
});

const ADAPTER = `import {readFileSync,appendFileSync} from 'node:fs';
const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;
const reply=research=>console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research}));
if(c.role==='assess-answer')reply({verdict:'supported',reasons:[]});
else {
 appendFileSync(process.argv[2],JSON.stringify(c)+'\\n');
 const source=(c.inventory??c.originals).sources[0],full=c.currentRead??c.history.find(t=>t.action.action==='read_source');
 if(!full)reply({action:'read_source',source:source.ref,start:0,end:source.length});
 else {const q=c.questions[0],values=JSON.parse(full.observation.value);
  reply({action:'answer',question:q.id,value:values[q.field],citations:[{source:source.ref,selector:{kind:'json-pointer',pointer:'/'+q.field.replaceAll('~','~0').replaceAll('/','~1')}}]});}
}`;

test("real research requests reference identical current answers while retaining original actions and full evidence reads", async t => {
  const { root, store, engine } = fixture(t);
  const values = { "preparedText": "A bounded prepared requirement. ".repeat(650), second: "Next result" };
  engine.discovery.evidence.document("p", "values", JSON.stringify(values), "application/json", 0);
  const adapter = join(root, "adapter.mjs"), requests = join(root, "requests.jsonl"); writeFileSync(adapter, ADAPTER);
  const command = { executable: process.execPath, args: [adapter, requests] };
  engine.environments.configure("p", { workspace: root, implementer: { actor: "author", model: "fixture", effort: "high", command },
    reviewer: { actor: "assessor", model: "fixture", effort: "high", command }, fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 3000 }, 0);
  const issued = engine.discovery.create("p", "discovery", "R0", "concept", Object.keys(values).map(field => ({ field,
    kind: "design", prompt: "Prepare this exact fixture property", risk: "Losing required content", schema: { type: "string" } })));
  const run = await engine.researcher.run("p", issued.id, 3);
  assert.equal(run.value.status, "completed", JSON.stringify(run.value));
  const packets = readFileSync(requests, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const final = packets.at(-1);
  const projected = final.history.find((turn: ResearchTurn) => (turn.action as {action:string}).action === "answer");
  assert.equal(projected.action.valuePointer, "/fields/preparedText");
  assert.equal(Object.hasOwn(projected.action, "value"), false);
  assert.equal(final.fields['preparedText'], values['preparedText']);
  assert.equal(JSON.parse(final.history.find((turn: ResearchTurn) => (turn.action as {action:string}).action === "read_source").observation.value)['preparedText'], values['preparedText']);
  const raw = store.list<ResearchTurn>("research-turn").find(turn => turn.value.number === projected.number)!;
  assert.equal((raw.value.action as {value:unknown}).value, values['preparedText']);
  assert.ok(JSON.stringify(raw.value).length - JSON.stringify(projected).length > 19_000);
  const draft = store.get<DiscoveryDraft>(issued.id)!;
  assert.deepEqual(researchHistory(store, draft.value, [{ ...raw.value, status: "pending" }])[0]!.action, raw.value.action);
  assert.deepEqual(researchHistory(store, draft.value, [{ ...raw.value, error: "A consumer refused this proposal" }])[0]!.action, raw.value.action);
  const changed = { ...raw.value, action: { ...(raw.value.action as object), value: "A different proposal" } };
  assert.deepEqual(researchHistory(store, draft.value, [changed])[0]!.action, changed.action);
  const question = store.get<Question>(issued.value.questions[0]!)!;
  engine.discovery.reopen(question.id, question.revision);
  assert.deepEqual(researchHistory(store, draft.value, [raw.value])[0]!.action, raw.value.action,
    "Reopened answers retain their full previous proposal for correction");
  assert.deepEqual(store.get(raw.id), raw, "Packet compaction never rewrites the research journal");
});
