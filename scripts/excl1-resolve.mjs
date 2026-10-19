// EXCL1 (№6687 п.1): registered by scripts/excl1-register.mjs under `npm run check:backend` only.
// 'node:test' imports of compiled test files resolve to the per-file exclusion wrapper instead; the
// ?f= query gives every importing file its own wrapper instance (its own exclusion set and counters).
const TEST_FILE = /\/dist\/test\/[^/]+\.test\.js$/;
export async function resolve(specifier, context, next) {
  if (specifier === "node:test" && context.parentURL) {
    const path = new URL(context.parentURL).pathname;
    const base = path.split("/").pop();
    if (TEST_FILE.test(path))
      return { url: new URL(`../dist/test/excl1-wrap.js?f=${base}`, import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
