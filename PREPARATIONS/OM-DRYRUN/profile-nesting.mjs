// Nesting of re-derivations in a .cpuprofile: for chosen functions, how many times each appears in one sampled stack,
// weighted by sample time — a function nested N deep re-derives itself N times on one path.
//   node profile-nesting.mjs <file.cpuprofile> fn1,fn2,...
import { readFileSync } from "node:fs";
const [file, list] = process.argv.slice(2);
const names = list.split(",");
const profile = JSON.parse(readFileSync(file, "utf8"));
const byId = new Map(profile.nodes.map(node => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
const depth = Object.fromEntries(names.map(name => [name, new Map()]));
let total = 0;
profile.samples.forEach((id, index) => {
  const delta = profile.timeDeltas[index] ?? 0; total += delta;
  const counts = Object.fromEntries(names.map(name => [name, 0]));
  for (let at = id; at !== undefined; at = parent.get(at)) { const fn = byId.get(at).callFrame.functionName; if (fn in counts) counts[fn]++; }
  for (const name of names) depth[name].set(counts[name], (depth[name].get(counts[name]) ?? 0) + delta);
});
for (const name of names) {
  const rows = [...depth[name]].filter(([n]) => n > 0).sort((a, b) => a[0] - b[0]);
  console.log(`${name.padEnd(32)} ${rows.map(([n, t]) => `×${n}: ${(100 * t / total).toFixed(1)}%`).join("  ")}`);
}
