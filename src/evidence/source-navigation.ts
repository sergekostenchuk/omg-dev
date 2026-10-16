import { digest } from '../canonical.js';
import { requireCondition } from '../errors.js';
import { verifySourceStructure, type SourceBlock, type SourceSection, type SourceStructure, type TextRange } from './source-structure.js';

export const STRUCTURED_READ_CONTRACT = 'source-read/v3' as const;
export const STRUCTURED_SEARCH_CONTRACT = 'research-search-capture/v2' as const;
export const WHOLE_DOCUMENT_LIMIT = 60_000;
export const ADDRESS_WINDOW_LIMIT = 50_000;
export const TAIL_LIMIT = 10_000;
export const SEARCH_FRAGMENT_LIMIT = 10;
export const SEARCH_TEXT_LIMIT = 50_000;

export interface StructuredReadSelection {
  outcome: 'complete' | 'clipped' | 'outside' | 'overview';
  requested: TextRange; served: TextRange | null; length: number; unit: 'utf16';
  selectionReason: 'whole_document' | 'overview' | 'short_tail' | 'paragraph_boundary' | 'sentence_boundary' | 'utf16_boundary' | 'outside';
  expanded: boolean; requestedCovered: boolean; documentComplete: boolean; paragraphSplit: boolean;
  nextAction: { action: 'search'; query: string } | null;
}

export function requireNavigationStructure(content: string, structure: SourceStructure): void {
  requireCondition(typeof content === 'string' && structure?.contentSha256 === digest(content)
    && structure.utf16Length === content.length && verifySourceStructure(content, structure),
  'source_structure_invalid', 'The saved Markdown index does not match the exact clean Source');
}

export function safeTextEnd(text: string, end: number): number {
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)
    && /[\uDC00-\uDFFF]/.test(text[end]!)) return end - 1;
  return end;
}
const textual = (kind: SourceBlock['kind']) => kind === 'paragraph' || kind === 'list';
function sentenceEnds(content: string, start: number, end: number, kind: SourceBlock['kind']): number[] {
  const matcher = textual(kind) ? /[.!?](?:["')\]]*)[ \t\r\n]+|\r?\n/g : /\r?\n/g;
  return [...content.slice(start, end).matchAll(matcher)].map(match => start + match.index + match[0].length);
}
function boundedEnd(content: string, structure: SourceStructure, start: number, ceiling: number, minimum = start + 1) {
  const blockEnd = structure.blocks.filter(block => block.range.start >= start && block.range.end >= minimum
    && block.range.end <= ceiling).at(-1)?.range.end;
  if (blockEnd !== undefined) return { end: blockEnd, reason: 'paragraph_boundary' as const };
  const block = structure.blocks.find(row => row.range.start <= Math.max(start, minimum - 1) && minimum - 1 < row.range.end);
  const sentence = sentenceEnds(content, start, ceiling, block?.kind ?? 'paragraph').filter(end => end >= minimum).at(-1);
  if (sentence !== undefined) return { end: sentence, reason: 'sentence_boundary' as const };
  return { end: safeTextEnd(content, ceiling), reason: 'utf16_boundary' as const };
}
function sectionAt(structure: SourceStructure, offset: number): SourceSection {
  return structure.sections.filter(row => row.headingRange && row.headingRange.start <= offset).at(-1)
    ?? structure.sections[0]!;
}
function sectionEnd(structure: SourceStructure, section: SourceSection, start: number, length: number): number {
  const next = structure.sections.find(row => row.headingRange && row.headingRange.start > start)?.headingRange?.start;
  return Math.min(length, section.bodyRange.end, next ?? length);
}

/** Policy v3 is derived only from the immutable Source and its exact index. */
export function selectStructuredRead(content: string, structure: SourceStructure, requested: TextRange): StructuredReadSelection {
  requireNavigationStructure(content, structure);
  requireCondition(requested && Number.isSafeInteger(requested.start) && Number.isSafeInteger(requested.end)
    && requested.start >= 0 && requested.end > requested.start, 'selector_invalid', 'A structured read needs a nonempty UTF-16 range');
  const length = content.length;
  const base = { requested: { ...requested }, length, unit: 'utf16' as const, nextAction: null, paragraphSplit: false };
  if (requested.start >= length) return { ...base, outcome: 'outside', served: null, selectionReason: 'outside',
    expanded: false, requestedCovered: false, documentComplete: false };
  if (length <= WHOLE_DOCUMENT_LIMIT) return { ...base, outcome: requested.end <= length ? 'complete' : 'clipped',
    served: { start: 0, end: length }, selectionReason: 'whole_document', expanded: requested.start > 0 || requested.end < length,
    requestedCovered: requested.end <= length, documentComplete: true };
  if (requested.start === 0 && requested.end >= length) return { ...base, outcome: 'overview', served: null,
    selectionReason: 'overview', expanded: false, requestedCovered: false, documentComplete: false,
    nextAction: { action: 'search', query: 'specific words from the TOC' } };
  const section = sectionAt(structure, requested.start);
  const limit = sectionEnd(structure, section, requested.start, length);
  const ceiling = Math.min(requested.end, requested.start + ADDRESS_WINDOW_LIMIT, limit);
  let { end, reason } = boundedEnd(content, structure, requested.start, ceiling);
  let selectionReason: StructuredReadSelection['selectionReason'] = reason;
  if (limit - end > 0 && limit - end < TAIL_LIMIT && limit - requested.start <= WHOLE_DOCUMENT_LIMIT) {
    end = limit; selectionReason = 'short_tail';
  }
  requireCondition(end > requested.start, 'selector_invalid', 'The requested UTF-16 window cannot advance without splitting a surrogate pair');
  const requestedCovered = end >= requested.end;
  return { ...base, outcome: requestedCovered ? 'complete' : 'clipped', served: { start: requested.start, end },
    selectionReason, expanded: end > requested.end, requestedCovered,
    documentComplete: requested.start === 0 && end === length,
    paragraphSplit: structure.blocks.some(block => block.range.start < end && end < block.range.end) };
}

export interface StructuredFragment {
  sectionId: string;
  sectionPath: { id: string; title: string | null; range: TextRange }[];
  heading: { range: TextRange; text: string } | null;
  range: TextRange; focus: TextRange; text: string; matchOffsets: number[]; matches: TextRange[]; sentenceSplit: boolean;
}
export interface StructuredSearchResult {
  fragments: StructuredFragment[]; found: number; delivered: number; truncated: boolean; hasMore: boolean;
  displayedChars: number;
}
function pathOf(structure: SourceStructure, sectionId: string): SourceSection[] {
  const rows: SourceSection[] = [];
  let section = structure.sections.find(row => row.id === sectionId);
  while (section) { if (section.headingRange) rows.unshift(section); section = structure.sections.find(row => row.id === section!.parentId); }
  return rows;
}
function logicalBlocks(structure: SourceStructure): SourceBlock[] {
  const result: SourceBlock[] = [];
  for (const block of structure.blocks) {
    const previous = result.at(-1);
    if (previous && previous.sectionId === block.sectionId && textual(previous.kind) && textual(block.kind)
      && previous.range.end - previous.range.start < 200) previous.range.end = block.range.end;
    else result.push({ ...block, range: { ...block.range } });
  }
  for (let i = result.length - 1; i > 0; i--) {
    const row = result[i]!, previous = result[i - 1]!;
    if (row.range.end - row.range.start < 200 && row.sectionId === previous.sectionId
      && textual(row.kind) && textual(previous.kind)) { previous.range.end = row.range.end; result.splice(i, 1); }
  }
  return result;
}
export function fragmentOverhead(fragment: Pick<StructuredFragment, 'heading' | 'sectionPath'>): number {
  return (fragment.heading?.text.length ?? 0) + fragment.sectionPath.reduce((sum, row) => sum + (row.title?.length ?? 0), 0);
}

/** The same cap applies in the per-source and mixed-source projections. */
export function clipStructuredFragment(content: string, structure: SourceStructure, fragment: StructuredFragment,
  bodyChars: number): StructuredFragment | null {
  if (fragment.text.length <= bodyChars) return fragment;
  // The matched paragraph/window has priority over either neighbouring context.
  if (bodyChars <= 0 || fragment.focus.end - fragment.focus.start > bodyChars) return null;
  let start = Math.max(fragment.range.start, fragment.focus.end - bodyChars);
  if (start > fragment.range.start) {
    const paragraph = structure.blocks.find(block => block.range.start >= start && block.range.start <= fragment.focus.start);
    const sentence = sentenceEnds(content, start, fragment.focus.start, 'paragraph')[0];
    start = paragraph?.range.start ?? sentence ?? start;
    if (start > 0 && /[\uDC00-\uDFFF]/.test(content[start]!) && /[\uD800-\uDBFF]/.test(content[start - 1]!)) start++;
  }
  const { end, reason } = boundedEnd(content, structure, start,
    Math.min(fragment.range.end, start + bodyChars), fragment.focus.end);
  if (end < fragment.focus.end) return null;
  const matches = fragment.matches.filter(match =>
    match.end <= fragment.range.start || match.start >= start && match.end <= end);
  return { ...fragment, range: { start, end }, text: content.slice(start, end),
    matches, matchOffsets: matches.map(match => match.start), sentenceSplit: fragment.sentenceSplit
      || reason === 'utf16_boundary' || structure.blocks.some(block => block.range.start < start && start < block.range.end) };
}

/** Stable relevance is Source Ref then original offset; no rewriting or case-folded offset arithmetic. */
export function searchStructuredSource(content: string, structure: SourceStructure, query: string,
  maxFragments = SEARCH_FRAGMENT_LIMIT, maxChars = SEARCH_TEXT_LIMIT): StructuredSearchResult {
  requireNavigationStructure(content, structure);
  requireCondition(typeof query === 'string' && !!query.trim() && query.length <= 1000,
    'research_query_invalid', 'A structured search needs a bounded nonempty query');
  const logical = logicalBlocks(structure), merged: StructuredFragment[] = [];
  const bySection = new Map<string, SourceBlock[]>(), positions = new Map<string, number>();
  const paths = new Map<string, SourceSection[]>(), ends = new Map<string, number[]>();
  for (const row of logical) {
    const rows = bySection.get(row.sectionId) ?? [];
    positions.set(row.id, rows.length); rows.push(row); bySection.set(row.sectionId, rows);
  }
  const lowerBound = (values: number[], at: number) => {
    let low = 0, high = values.length;
    while (low < high) { const mid = (low + high) >>> 1; if (values[mid]! < at) low = mid + 1; else high = mid; }
    return low;
  };
  let blockCursor = 0, headingCursor = 0, found = 0;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const match of content.matchAll(new RegExp(escaped, 'giu'))) {
    const offset = match.index, matchEnd = offset + match[0].length;
    while (blockCursor < logical.length && logical[blockCursor]!.range.end <= offset) blockCursor++;
    const block = logical[blockCursor];
    const main = block && block.range.start <= offset && matchEnd <= block.range.end ? block : null;
    while (headingCursor + 1 < structure.sections.length
      && structure.sections[headingCursor + 1]!.headingRange!.start <= offset) headingCursor++;
    const headingSection = structure.sections[headingCursor];
    const header = !main && headingSection?.headingRange && headingSection.headingRange.start <= offset
      && matchEnd <= headingSection.headingRange.end ? headingSection : null;
    if (!main && !header) continue;
    found++;
    const sectionId = main?.sectionId ?? header!.id;
    const rows = bySection.get(sectionId) ?? [], within = main ? positions.get(main.id)! : 0;
    let range: TextRange, focus: TextRange, sentenceSplit = false;
    if (main && main.range.end - main.range.start > 5_000) {
      const low = Math.max(main.range.start, offset - 2_000), high = Math.min(main.range.end, matchEnd + 2_000);
      let boundaries = ends.get(main.id);
      if (!boundaries) { boundaries = sentenceEnds(content, main.range.start, main.range.end, main.kind); ends.set(main.id, boundaries); }
      const nextStart = boundaries[lowerBound(boundaries, low)];
      const startBoundary = nextStart !== undefined && nextStart <= offset ? nextStart : undefined;
      let start = startBoundary ?? low;
      if (start > 0 && /[\uDC00-\uDFFF]/.test(content[start]!) && /[\uD800-\uDBFF]/.test(content[start - 1]!)) start++;
      const previousEnd = boundaries[lowerBound(boundaries, high + 1) - 1];
      const endBoundary = previousEnd !== undefined && previousEnd >= matchEnd ? previousEnd : undefined;
      const end = endBoundary ?? safeTextEnd(content, high);
      range = { start, end }; focus = { ...range }; sentenceSplit = (startBoundary === undefined && start > main.range.start)
        || (endBoundary === undefined && end < main.range.end);
    } else if (rows.length) {
      const from = within === rows.length - 1 ? Math.max(0, within - 2) : Math.max(0, within - 1);
      const to = within === 0 ? Math.min(rows.length - 1, within + 2) : Math.min(rows.length - 1, within + 1);
      range = { start: rows[from]!.range.start, end: rows[to]!.range.end };
      focus = main ? { ...main.range } : { start: range.start, end: range.start };
      // A long neighbour supplies only the edge nearest the main paragraph.
      // Keeping a single exact slice also drops context beyond that trimmed block.
      for (let i = from; i <= to; i++) {
        const neighbour = rows[i]!;
        if (i === within || neighbour.range.end - neighbour.range.start <= 5_000) continue;
        let boundaries = ends.get(neighbour.id);
        if (!boundaries) { boundaries = sentenceEnds(content, neighbour.range.start, neighbour.range.end, neighbour.kind); ends.set(neighbour.id, boundaries); }
        if (i < within) {
          const low = neighbour.range.end - 2_000, boundary = boundaries[lowerBound(boundaries, low)];
          let start = boundary !== undefined && boundary < neighbour.range.end ? boundary : low;
          if (start > 0 && /[\uDC00-\uDFFF]/.test(content[start]!) && /[\uD800-\uDBFF]/.test(content[start - 1]!)) start++;
          range.start = start; sentenceSplit ||= boundary === undefined || boundary >= neighbour.range.end;
        } else {
          const high = neighbour.range.start + 2_000, boundary = boundaries[lowerBound(boundaries, high + 1) - 1];
          range.end = boundary !== undefined && boundary > neighbour.range.start ? boundary : safeTextEnd(content, high);
          sentenceSplit ||= boundary === undefined || boundary <= neighbour.range.start;
          break;
        }
      }
    } else { range = { start: header!.headingRange!.end, end: header!.headingRange!.end }; focus = { ...range }; }
    const previous = merged.at(-1);
    if (previous && previous.sectionId === sectionId && range.start <= previous.range.end && range.end >= previous.range.start) {
      previous.range.start = Math.min(previous.range.start, range.start);
      previous.range.end = Math.max(previous.range.end, range.end);
      previous.matches.push({ start: offset, end: matchEnd }); previous.matchOffsets.push(offset);
      previous.sentenceSplit ||= sentenceSplit;
      // A neighbouring paragraph can join two previously separate long-block windows.
      let joined = previous, earlier = merged.at(-2);
      while (earlier?.sectionId === sectionId && joined.range.start <= earlier.range.end) {
        earlier.range.start = Math.min(earlier.range.start, joined.range.start);
        earlier.range.end = Math.max(earlier.range.end, joined.range.end);
        for (const item of joined.matches) earlier.matches.push(item);
        for (const item of joined.matchOffsets) earlier.matchOffsets.push(item);
        earlier.sentenceSplit ||= joined.sentenceSplit; merged.pop();
        joined = earlier; earlier = merged.at(-2);
      }
    } else {
      let path = paths.get(sectionId);
      if (!path) { path = pathOf(structure, sectionId); paths.set(sectionId, path); }
      const heading = path.at(-1)?.headingRange ?? null;
      merged.push({ sectionId, sectionPath: path.map(row => ({ id: row.id, title: row.title, range: row.headingRange! })),
        heading: heading ? { range: heading, text: content.slice(heading.start, heading.end) } : null,
        range, focus, text: '', matches: [{ start: offset, end: matchEnd }], matchOffsets: [offset], sentenceSplit });
    }
  }
  const fragments: StructuredFragment[] = []; let displayedChars = 0, clipped = false;
  for (const candidate of merged) {
    if (fragments.length >= maxFragments) break;
    candidate.text = content.slice(candidate.range.start, candidate.range.end);
    const overhead = fragmentOverhead(candidate), room = maxChars - displayedChars - overhead;
    if (room < 0) { clipped = true; continue; }
    const fragment = clipStructuredFragment(content, structure, candidate, room);
    if (!fragment) { clipped = true; continue; }
    fragments.push(fragment); displayedChars += overhead + fragment.text.length;
    if (fragment.range.start !== candidate.range.start || fragment.range.end !== candidate.range.end) clipped = true;
  }
  const truncated = clipped || fragments.length < merged.length;
  return { fragments, found, delivered: fragments.length, truncated, hasMore: truncated, displayedChars };
}
