import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { Store } from "../storage/store.js";
import { Evidence, sourceIsCurrent, type Source } from "../evidence/evidence.js";
import { reference, type Ref } from "../pipeline/contracts.js";
import { digest } from "../canonical.js";
import { workspacePath, gitBytes } from "../runtime/environment.js";
import { requireCondition } from "../errors.js";

export class ResearchSources {
  constructor(private readonly store: Store, private readonly project: string, private readonly root: string) {}
  list() {
    return this.store.list<Source>("source").filter(item => item.value.projectId === this.project && sourceIsCurrent(item.value));
  }
  inventory() {
    let files: string[] = [];
    try { files = gitBytes(this.root, ["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean); } catch { /* A new product can begin from documents without a repository. */ }
    return { sources: this.list().map(item => {
      // File bytes are delivered by read/read_source/search when requested.
      // Repeating every captured code header in every request wastes context.
      const excerpt = item.value.origin.kind === "file" ? "" : item.value.content.slice(0, 3000);
      return { ref: reference(item), kind: item.value.origin.kind, location: item.value.origin.location,
        media: item.value.mediaType, length: item.value.content.length, excerpt, truncated: item.value.content.length > excerpt.length };
    }),
      files: files.slice(0, 2000), filesTruncated: files.length > 2000 };
  }
  read(path: string, media: Source['mediaType']) {
    const location = realpathSync(workspacePath(this.root, path));
    const key = `research-${digest(path).slice(0, 32)}`;
    const old = this.store.get<Source>(`source:${this.project}:${key}`);
    if (old && old.value.origin.location === location && old.value.mediaType === media && sourceIsCurrent(old.value)) return old;
    return new Evidence(this.store).file(this.project, key, this.root, path, media, old?.revision ?? 0);
  }
  excerpt(ref: Ref, start: number, end: number) {
    requireCondition(end - start <= 50_000, "research_excerpt_limit", "Read a smaller source range");
    return new Evidence(this.store).observe(this.project, ref, { kind: "text-range", start, end });
  }
  search(query: string) {
    requireCondition(query.trim().length > 0 && query.length <= 1000, "research_query_invalid", "Use a nonempty bounded search query");
    const sources = this.list().flatMap(source => {
      const offset = source.value.content.toLowerCase().indexOf(query.toLowerCase());
      return offset < 0 ? [] : [{ source: reference(source), offset, excerpt: source.value.content.slice(Math.max(0, offset - 200), offset + 1200) }];
    });
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "grep", "-n", "-I", "-i", "-F", "-e", query, "--"],
      { cwd: this.root, encoding: "utf8", timeout: 10_000, maxBuffer: 200_000,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))) });
    return { sources, repositoryMatches: (result.stdout ?? "").slice(0, 20_000),
      repositoryStatus: result.status === 0 ? "matches" : result.status === 1 ? "no_matches" : "unavailable_or_truncated" };
  }
}
