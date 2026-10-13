import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { Store, type Revision, type Write } from "../storage/store.js";
import { Evidence, sourceIsCurrent, type Source } from "../evidence/evidence.js";
import { reference, type Ref } from "../pipeline/contracts.js";
import { digest } from "../canonical.js";
import { workspacePath, gitBytes } from "../runtime/environment.js";
import type { ResearchTurn } from './research-model.js';
import { projectResearchSearchObservation, projectSearchTurnCompletion, requireSearchQuery,
  type ResearchSearchProcess } from './research-consumer-transition.js';

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
        ...(item.value.provenance?{provenance:item.value.provenance}:{}),
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
    return new Evidence(this.store).readSource(this.project, ref, { start, end });
  }
  private searchFacts(query: string) {
    requireSearchQuery(query);
    const sources = this.list();
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "grep", "-n", "-I", "-i", "-F", "-e", query, "--"],
      { cwd: this.root, encoding: "utf8", timeout: 10_000, maxBuffer: 200_000,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))) });
    const error = result.error as NodeJS.ErrnoException | undefined;
    const processFacts: ResearchSearchProcess = { stdout: result.stdout ?? null,
      status: result.status, signal: result.signal,
      error: error ? { name: error.name, message: error.message,
        code: typeof error.code === 'string' ? error.code : null } : null };
    return { sources: sources.map(source => ({ ref: reference(source), value: source.value })),
      process: processFacts };
  }
  search(query: string) {
    const facts = this.searchFacts(query);
    return projectResearchSearchObservation(query, facts.sources, facts.process);
  }
  /** Prepare the capture and turn result from one Source enumeration and one
   * git grep. The caller writes both with its run in one guarded transaction. */
  searchCaptured(query: string, turn: Revision<ResearchTurn>,
    parent?: { original: Revision<ResearchTurn>; queued: Revision<ResearchTurn> }):
    { turn: ResearchTurn; capture: Write; captureRef: Ref; guards: Ref[] } {
    const facts = this.searchFacts(query);
    const projected = projectSearchTurnCompletion({ projectId: this.project,
      turn, store: this.store, ...(parent ? { parent } : {}), query, workspace: this.root, ...facts });
    const capture: Write = { id: projected.capture.id,
      kind: 'research-search-capture', expected: 0, value: projected.capture.value };
    return { turn: projected.turn, capture, captureRef: projected.capture.ref,
      // The original parent is an exact historical proof, while its queued
      // revision is the current CAS guard for this child application.
      guards: [reference(turn), ...(parent ? [reference(parent.queued)] : []),
        ...facts.sources.map(source => source.ref)] };
  }
}
