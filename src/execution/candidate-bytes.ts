import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { gitBytes, workspacePath } from "../runtime/environment.js";
import { requireCondition, EngineError } from "../errors.js";

/** Git filters and line-ending conversion must not substitute different accepted code. */
export function requireCandidateBytes(root: string, tree: string): void {
  const entries = gitBytes(root, ["ls-tree", "-r", "-z", tree]).toString("utf8").split("\0").filter(Boolean);
  for (const entry of entries) {
    const split = entry.indexOf("\t"), path = entry.slice(split + 1);
    const [mode, type, expected] = entry.slice(0, split).split(" ");
    requireCondition(type === "blob" && expected && [40, 64].includes(expected.length), "candidate_entry_unsupported", "A checked candidate must contain supported Git file objects");
    const hash = createHash(expected.length === 40 ? "sha1" : "sha256");
    if (mode === "120000") {
      const target = resolve(root, path);
      requireCondition(lstatSync(target).isSymbolicLink(), "candidate_bytes_mismatch", `Git and working tree disagree on link ${path}`);
      const bytes = readlinkSync(target, { encoding: "buffer" });
      hash.update(`blob ${bytes.length}\0`); hash.update(bytes);
    } else {
      const target = workspacePath(root, path);
      const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = fstatSync(fd);
        requireCondition(before.isFile() && Boolean(before.mode & 0o111) === (mode === "100755"), "candidate_bytes_mismatch", `Git and working tree disagree on file mode ${path}`);
        hash.update(`blob ${before.size}\0`);
        const buffer = Buffer.alloc(64 * 1024); let position = 0;
        while (position < before.size) {
          const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - position), position);
          requireCondition(count > 0, "candidate_bytes_changed", `The file was truncated while capturing ${path}`);
          hash.update(buffer.subarray(0, count)); position += count;
        }
        const after = fstatSync(fd);
        requireCondition(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,
          "candidate_bytes_changed", `The file changed while capturing ${path}`);
      } finally { closeSync(fd); }
    }
    if (hash.digest("hex") !== expected) throw new EngineError("candidate_bytes_mismatch", `The checked file differs from the Git candidate: ${path}`);
  }
}
