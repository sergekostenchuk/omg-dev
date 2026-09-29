// Saves om-stop for the dry-run pass from its own store (the running drive sees it at its next admission).
const [code, db] = process.argv.slice(2);
const { Store } = await import(`${code}/dist/src/storage/store.js`);
const { ProductEngine } = await import(`${code}/dist/src/product/engine.js`);
const store = new Store(db);
try { const answer = new ProductEngine(store).execute({ type: "om-stop", project: "omg-live" });
  console.log(JSON.stringify({ ok: answer.ok, stopped: answer.value?.stopped, finished: answer.value?.finished,
    pending: answer.value?.pending?.map(item => `${item.code}@${item.at.target}:${item.at.field}`), token: answer.value?.control?.value?.stop?.token })); }
finally { store.close(); }
