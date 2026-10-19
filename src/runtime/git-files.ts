import { gitBytes } from "./environment.js";
import { requireCondition } from "../errors.js";

export function treeFile(root: string, revision: string, path: string): Buffer | null {
  const entries = gitBytes(root, ["ls-tree", "-z", revision, "--", path]).toString("utf8").split("\0").filter(Boolean);
  const entry = entries.find(entry => entry.slice(entry.indexOf("\t") + 1) === path);
  if (!entry) return null;
  const [, type, oid] = entry.slice(0, entry.indexOf("\t")).split(" ");
  requireCondition(type === "blob" && oid && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid),
    "tree_file_invalid", "Code evidence must name a file, not a directory");
  // The blob identity is already in ls-tree. Reuse it across paths/commits through the common API;
  // do not resolve a symbolic revision again between finding the entry and reading its bytes.
  return gitBytes(root, ["cat-file", "blob", oid]);
}
