import { canonical, digest, hashJson } from '../canonical.js';
import { requireCondition } from '../errors.js';

export const SOURCE_STRUCTURE_CONTRACT = 'source-structure/v1' as const;
export const SOURCE_STRUCTURE_PARSER = 'markdown-sections/v1' as const;
export interface TextRange { start: number; end: number }
export interface SourceSection {
  id: string; level: number; title: string | null; parentId: string | null;
  headingRange: TextRange | null; bodyRange: TextRange;
}
export interface SourceBlock {
  id: string; sectionId: string; kind: 'paragraph' | 'list' | 'table' | 'fenced-code'; range: TextRange;
}
export interface SourceStructure {
  contract: typeof SOURCE_STRUCTURE_CONTRACT; parserContract: typeof SOURCE_STRUCTURE_PARSER;
  contentSha256: string; utf16Length: number; sections: SourceSection[]; blocks: SourceBlock[];
  structureHash: string;
}

interface Line { start: number; contentEnd: number; end: number; text: string }
function linesOf(content: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index++) {
    if (content[index] !== '\n' && content[index] !== '\r') continue;
    const contentEnd = index;
    if (content[index] === '\r' && content[index + 1] === '\n') index++;
    const end = index + 1;
    lines.push({ start, contentEnd, end, text: content.slice(start, contentEnd) });
    start = end;
  }
  if (start < content.length) lines.push({ start, contentEnd: content.length, end: content.length, text: content.slice(start) });
  return lines;
}
const fenceStart = (line: string): { marker: string; count: number } | null => {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  return match ? { marker: match[1]![0]!, count: match[1]!.length } : null;
};
const fenceEnd = (line: string, fence: { marker: string; count: number }): boolean => {
  const marker = fence.marker === '`' ? '`' : '~';
  return new RegExp(`^ {0,3}${marker === '`' ? '\\`' : marker}{${fence.count},}[ \\t]*$`).test(line);
};
const atx = (line: string): { level: number; title: string } | null => {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/.exec(line);
  return match ? { level: match[1]!.length, title: match[2]!.replace(/[ \t]+#+[ \t]*$/, '').trim() } : null;
};
const setext = (line: string): number | null => {
  const match = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
  return match ? (match[1]![0] === '=' ? 1 : 2) : null;
};
const list = (line: string): boolean => /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/.test(line);
const tableDivider = (line: string): boolean => {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|');
  return cells.length >= 2 && cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()));
};

/** All offsets refer to the exact saved JavaScript string, including CRLF and surrogate pairs. */
export function buildSourceStructure(content: string): SourceStructure {
  requireCondition(typeof content === 'string', 'source_structure_invalid', 'A Markdown structure needs saved text');
  const lines = linesOf(content), root: SourceSection = { id: 'section:v1:root', level: 0,
    title: null, parentId: null, headingRange: null, bodyRange: { start: 0, end: content.length } };
  const sections: SourceSection[] = [root], blocks: SourceBlock[] = [], stack: SourceSection[] = [root];
  let pending: { kind: SourceBlock['kind']; start: number; end: number } | null = null;
  const flush = () => {
    if (!pending) return;
    blocks.push({ id: `block:v1:${pending.start}`, sectionId: stack.at(-1)!.id,
      kind: pending.kind, range: { start: pending.start, end: pending.end } });
    pending = null;
  };
  const heading = (level: number, title: string, start: number, end: number) => {
    flush();
    if (sections.length === 1) root.bodyRange.end = start;
    while (stack.length > 1 && stack.at(-1)!.level >= level) stack.pop()!.bodyRange.end = start;
    const section: SourceSection = { id: `section:v1:${start}`, level, title,
      parentId: stack.at(-1)!.id, headingRange: { start, end }, bodyRange: { start: end, end: content.length } };
    sections.push(section); stack.push(section);
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fence = fenceStart(line.text);
    if (fence) {
      flush();
      let end = line.end;
      while (index + 1 < lines.length) {
        const next = lines[++index]!;
        end = next.end;
        if (fenceEnd(next.text, fence)) break;
      }
      blocks.push({ id: `block:v1:${line.start}`, sectionId: stack.at(-1)!.id,
        kind: 'fenced-code', range: { start: line.start, end } });
      continue;
    }
    const header = atx(line.text);
    if (header) { heading(header.level, header.title, line.start, line.end); continue; }
    const underline = setext(line.text);
    if (underline && pending?.kind === 'paragraph') {
      const start = pending.start;
      const title = content.slice(start, pending.end).trim().replace(/\s*\r?\n\s*/g, ' ');
      pending = null;
      heading(underline, title, start, line.end);
      continue;
    }
    if (!line.text.trim()) { flush(); continue; }
    const next = lines[index + 1];
    const activeKind: SourceBlock['kind'] | undefined = (pending as { kind: SourceBlock['kind']; start: number; end: number } | null)?.kind;
    const kind: SourceBlock['kind'] = list(line.text) ? 'list'
      : ((line.text.includes('|') && next && tableDivider(next.text)) || (activeKind === 'table' && line.text.includes('|')))
        ? 'table' : 'paragraph';
    if (pending && pending.kind !== kind) flush();
    if (!pending) pending = { kind, start: line.start, end: line.end };
    else pending.end = line.end;
  }
  flush();
  while (stack.length > 1) stack.pop()!.bodyRange.end = content.length;
  const body = { contract: SOURCE_STRUCTURE_CONTRACT, parserContract: SOURCE_STRUCTURE_PARSER,
    contentSha256: digest(content), utf16Length: content.length, sections, blocks };
  return { ...body, structureHash: hashJson(body) };
}

/** A saved index is proof only when it is exactly the output for the saved clean text. */
export function verifySourceStructure(content: string, structure: SourceStructure): boolean {
  try { return canonical(buildSourceStructure(content)) === canonical(structure); }
  catch { return false; }
}
