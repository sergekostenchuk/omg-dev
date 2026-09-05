import { gitBytes } from "./environment.js";
import { requireCondition } from "../errors.js";

export function treeFile(root: string, revision: string, path: string): Buffer | null {
  const entries = gitBytes(root, ["ls-tree", "-z", revision, "--", path]).toString("utf8").split("\0").filter(Boolean);
  const entry = entries.find(entry => entry.slice(entry.indexOf("\t") + 1) === path);
  if (!entry) return null;
  requireCondition(entry.slice(0, entry.indexOf("\t")).split(" ")[1] === "blob", "tree_file_invalid", "Code evidence must name a file, not a directory");
  return gitBytes(root, ["show", `${revision}:${path}`]);
}
