// Summary of a V8 .cpuprofile: self time (the sampled leaf) and inclusive time (on the stack, counted once per sample)
// per function, as shares of the whole profile.
//
//   node profile-summary.mjs <file.cpuprofile> [top=25]
import { readFileSync } from "node:fs";

const [file, topArg] = process.argv.slice(2);
const top = Number(topArg ?? 25);
const profile = JSON.parse(readFileSync(file, "utf8"));
const byId = new Map(profile.nodes.map(node => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
const key = node => {
  const frame = node.callFrame, url = frame.url.replace(/^.*\/dist\//, "").replace(/^file:\/\//, "");
  return `${frame.functionName || "(anonymous)"} ${url ? `${url}:${frame.lineNumber + 1}` : ""}`.trim();
};
const self = new Map(), inclusive = new Map();
let total = 0;
profile.samples.forEach((id, index) => {
  const delta = profile.timeDeltas[index] ?? 0;
  total += delta;
  const leaf = byId.get(id);
  self.set(key(leaf), (self.get(key(leaf)) ?? 0) + delta);
  const seen = new Set();
  for (let at = id; at !== undefined; at = parent.get(at)) {
    const name = key(byId.get(at));
    if (!seen.has(name)) { seen.add(name); inclusive.set(name, (inclusive.get(name) ?? 0) + delta); }
  }
});
const show = (title, map) => {
  console.log(`\n${title}`);
  for (const [name, time] of [...map].sort((a, b) => b[1] - a[1]).slice(0, top))
    console.log(`${(time / 1e6).toFixed(1).padStart(8)} s ${(100 * time / total).toFixed(1).padStart(5)}%  ${name}`);
};
console.log(`${file}: ${(total / 1e6).toFixed(1)} s sampled`);
show("SELF", self);
show("INCLUSIVE (om/, storage/, canonical, runtime/)", new Map([...inclusive].filter(([name]) => /src\/(om|storage|runtime|canonical|pipeline|graph)/.test(name) || /^\(garbage/.test(name))));
