// Volume estimate of the dry run: for every M6 batch of the pass's routes, the first question packet the common producer
// would build (prepareQuestionPacket, no write), with its size against the request capacity.
//
//   node packet-sizes.mjs --code <built checkout> --db <copy.sqlite>
//
// The request of the first saved packet is the template; only its batch changes (attempt: the template's, then null).
import { resolve } from "node:path";

const arg = name => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : undefined; };
const code = resolve(arg("code")), db = resolve(arg("db")), project = "omg-live";
const { Store } = await import(`${code}/dist/src/storage/store.js`);
const { prepareQuestionPacket } = await import(`${code}/dist/src/om/question-packet.js`);
const store = new Store(db);
const saved = store.list().filter(row => row.id.startsWith(`om-question-packet:${project}`))
  .flatMap(row => store.history(row.id)).sort((a, b) => a.revision - b.revision);
const template = saved[0].value.request;
const routes = store.get(template.routes.id, template.routes.revision).value;
const environment = store.get(template.environment.id, template.environment.revision).value;
const capacity = environment.requestCapacityChars;
console.log(`routes ${template.routes.id} r${template.routes.revision}: ${routes.batches.length} batches; capacity ${capacity}`);
let total = 0;
for (const batch of routes.batches) {
  const tries = [{ ...template, batch: batch.id, previous: [] }, { ...template, batch: batch.id, previous: [], attempt: null }];
  let line = `${batch.model} ${batch.task} L${batch.level ?? "-"} node=${batch.node ?? "-"} items=${batch.items.length}`;
  for (const request of tries) {
    const t0 = Date.now(), prepared = prepareQuestionPacket(store, request);
    if (!prepared.ok) { line += ` | attempt=${request.attempt ? "saved" : "null"}: REFUSED ${prepared.refusal.code} ${prepared.refusal.at.field}`; continue; }
    const record = prepared.value.record?.value ?? prepared.value.value ?? prepared.value;
    const chars = record.fingerprint?.chars ?? null, parts = record.plan?.assignments?.length ?? 1;
    total += chars ?? 0;
    line += ` | state=${record.state} chars=${chars} (${chars ? (100 * chars / capacity).toFixed(1) : "-"}% of capacity) parts=${parts} ${Date.now() - t0} ms`;
    break;
  }
  console.log(line);
}
console.log(`sum of first packets: ${total} chars ≈ ${Math.round(total / 3.5)} tokens (3.5 chars/token, rough)`);
store.close();
