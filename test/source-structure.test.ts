import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, hashJson } from '../src/canonical.js';
import { buildSourceStructure, verifySourceStructure } from '../src/evidence/source-structure.js';

const slice = (text: string, range: { start: number; end: number }) => text.slice(range.start, range.end);

test('SR1b exact UTF-16 sections and block ranges survive CRLF, emoji, duplicate titles and skipped levels', () => {
  const text = 'Before 😀\r\n\r\n# Same\r\nA [link](https://example.org) <b>x</b>\r\n\r\n'
    + '```md\r\n# Inside code\r\n```\r\n\r\n### Deep\r\n- first\r\n- second\r\n\r\n'
    + 'H2 later\r\n---------\r\n| key | value |\r\n| --- | --- |\r\n| a | 😀 |\r\n\r\n# Same\r\nEnd';
  const result = buildSourceStructure(text);
  assert.equal(result.contentSha256, digest(text));
  assert.equal(result.utf16Length, text.length);
  assert.equal(result.sections.length, 5);
  assert.deepEqual(result.sections.map(row => [row.level, row.title]),
    [[0, null], [1, 'Same'], [3, 'Deep'], [2, 'H2 later'], [1, 'Same']]);
  assert.equal(result.sections[2]!.parentId, result.sections[1]!.id, 'a skipped H2 adds no fictitious section');
  assert.equal(result.sections[3]!.parentId, result.sections[1]!.id);
  assert.notEqual(result.sections[1]!.id, result.sections[4]!.id, 'duplicate titles have position IDs');
  assert.equal(slice(text, result.sections[3]!.headingRange!), 'H2 later\r\n---------\r\n');
  assert.equal(slice(text, result.sections[0]!.bodyRange), 'Before 😀\r\n\r\n');
  assert.deepEqual(result.blocks.map(row => row.kind), ['paragraph', 'paragraph', 'fenced-code', 'list', 'table', 'paragraph']);
  assert.equal(slice(text, result.blocks[2]!.range), '```md\r\n# Inside code\r\n```\r\n');
  assert.equal(slice(text, result.blocks[4]!.range), '| key | value |\r\n| --- | --- |\r\n| a | 😀 |\r\n');
  assert.equal(result.blocks[3]!.sectionId, result.sections[2]!.id);
  assert.equal(result.blocks[4]!.sectionId, result.sections[3]!.id);
  for (const block of result.blocks) assert.ok(block.range.start >= 0 && block.range.end <= text.length);
  assert.equal(result.structureHash, hashJson(Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'structureHash'))));
  assert.equal(verifySourceStructure(text, result), true);
  assert.equal(verifySourceStructure(text + 'x', result), false);
  assert.equal(verifySourceStructure(text, { ...result, blocks: result.blocks.slice(1) }), false);
});

test('SR1b no heading, empty content and one huge paragraph retain honest root structure', () => {
  for (const text of ['', 'x'.repeat(100_000)]) {
    const result = buildSourceStructure(text);
    assert.deepEqual(result.sections.map(row => [row.level, row.headingRange, row.bodyRange]),
      [[0, null, { start: 0, end: text.length }]]);
    assert.equal(result.blocks.length, text ? 1 : 0);
    if (text) assert.equal(slice(text, result.blocks[0]!.range), text);
    assert.equal(verifySourceStructure(text, result), true);
  }
});

test('SR1b fenced code and inline markdown never create false headings or shifted offsets', () => {
  const text = '~~~\n# not a heading\n~~~\n# Real [link](https://example.org)\nBody';
  const result = buildSourceStructure(text);
  assert.equal(result.sections.length, 2);
  assert.equal(result.sections[1]!.title, 'Real [link](https://example.org)');
  assert.equal(result.blocks[0]!.kind, 'fenced-code');
  assert.equal(slice(text, result.blocks[0]!.range), '~~~\n# not a heading\n~~~\n');
  assert.equal(slice(text, result.blocks[1]!.range), 'Body');
});
