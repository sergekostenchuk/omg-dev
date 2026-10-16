import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSourceStructure } from '../src/evidence/source-structure.js';
import { selectStructuredRead, searchStructuredSource } from '../src/evidence/source-navigation.js';

test('SR1c whole-document threshold and addressed windows preserve requested and exact served UTF-16', () => {
  for (const length of [59_999, 60_000]) {
    const text = 'x'.repeat(length);
    const reading = selectStructuredRead(text, buildSourceStructure(text), { start: 3, end: 20 });
    assert.equal(reading.outcome, 'complete');
    assert.deepEqual(reading.served, { start: 0, end: length });
    assert.equal(reading.selectionReason, 'whole_document');
    assert.equal(reading.expanded, true);
    assert.equal(reading.documentComplete, true);
  }
  const long = 'x'.repeat(60_001);
  const structure = buildSourceStructure(long);
  const overview = selectStructuredRead(long, structure, { start: 0, end: long.length });
  assert.equal(overview.outcome, 'overview');
  assert.equal(overview.served, null);
  assert.equal(overview.documentComplete, false);
  assert.equal(overview.nextAction?.action, 'search');
  const addressed = selectStructuredRead(long, structure, { start: 100, end: 59_999 });
  assert.equal(addressed.served?.start, 100);
  assert.ok(addressed.served!.end > 100 && addressed.served!.end === long.length,
    'the strictly shorter tail may extend the addressed window');
  assert.equal(addressed.paragraphSplit, false);
  assert.equal(selectStructuredRead(long, structure, { start: long.length, end: long.length + 1 }).outcome, 'outside');
  assert.throws(() => selectStructuredRead(long, structure, { start: 1, end: 1 }), { code: 'selector_invalid' });
  assert.throws(() => selectStructuredRead(long, { ...structure, structureHash: '0' }, { start: 1, end: 2 }),
    { code: 'source_structure_invalid' });
});

test('SR1c strict tail and paragraph boundaries do not cross a section', () => {
  const text = '# One\n' + ('p'.repeat(24_900) + '\n\n') + ('q'.repeat(24_900) + '\n\n')
    + ('r'.repeat(9_999) + '\n') + '# Two\n' + 'Outside'.repeat(1_000);
  const structure = buildSourceStructure(text);
  const end = structure.sections[1]!.bodyRange.end;
  const read = selectStructuredRead(text, structure, { start: 6, end });
  assert.ok(read.served!.end <= end);
  assert.equal(read.served!.start, 6);
  assert.equal(read.requested.end, end);
  assert.equal(read.documentComplete, false);
  assert.equal(text.slice(read.served!.end).includes('Outside'), true);
});

test('SR1c search keeps original offsets, owning section and separately addressed heading', () => {
  const text = '# First\nShort.\n\nAnother paragraph with NeedLe and detail.\n\nThird paragraph.\n'
    + '# Second\nSecond text Needle.\n';
  const found = searchStructuredSource(text, buildSourceStructure(text), 'needle');
  assert.equal(found.found, 2);
  assert.equal(found.delivered, 2);
  assert.equal(found.fragments[0]!.sectionPath.at(-1)?.title, 'First');
  assert.equal(found.fragments[1]!.sectionPath.at(-1)?.title, 'Second');
  assert.equal(found.fragments[0]!.heading?.text, '# First\n');
  assert.equal(found.fragments[0]!.text, text.slice(found.fragments[0]!.range.start, found.fragments[0]!.range.end));
  assert.ok(found.fragments[0]!.range.end <= text.indexOf('# Second'));
  assert.deepEqual(found.fragments.map(row => row.matchOffsets.map(offset => text.slice(offset, offset + 6).toLowerCase())),
    [['needle'], ['needle']]);
  const none = searchStructuredSource(text, buildSourceStructure(text), 'not found');
  assert.equal(none.delivered, 0);
  assert.equal(none.hasMore, false);
});

test('SR1c oversized logical paragraph is bounded and overlapping hits merge before count', () => {
  const text = '# Part\n' + 'a'.repeat(3_000) + 'NEEDLE' + 'b'.repeat(3_000) + 'NEEDLE' + 'c'.repeat(2_000);
  const found = searchStructuredSource(text, buildSourceStructure(text), 'needle');
  assert.equal(found.found, 2);
  assert.equal(found.delivered, 1);
  assert.ok(found.fragments[0]!.text.length <= 8_012);
  assert.equal(found.fragments[0]!.matchOffsets.length, 2);
  assert.ok(found.fragments[0]!.sentenceSplit);
});

for (const tail of [9_999, 10_000]) test(`SR1c outcome 3: exact ${tail} tail and original requested`, () => {
  const prefix = 'a'.repeat(49_999) + '\n\n' + 'b'.repeat(tail - 2) + '\n';
  const content = prefix + '# Other\n' + 'x'.repeat(2_000);
  const selected = selectStructuredRead(content, buildSourceStructure(content), { start: 0, end: 50_000 });
  assert.equal(selected.served!.end, tail === 9_999 ? prefix.length : 50_000);
  assert.equal(selected.expanded, tail === 9_999);
  assert.deepEqual(selected.requested, { start: 0, end: 50_000 });
  assert.equal(selected.requestedCovered, true); assert.equal(selected.documentComplete, false);
  assert.equal(selected.paragraphSplit, false);
});

for (const body of [' '.repeat(60_100), 'x'.repeat(49_999) + '😀' + 'y'.repeat(80_000),
  '```\n' + 'x'.repeat(80_000) + '\n```', ('Sentence with detail. '.repeat(5_000))])
  test(`SR1c outcome 4: advancing fallback ${body.slice(0, 12).trim() || 'no paragraphs'}`, () => {
    const text = '# Long\n' + body, index = buildSourceStructure(text);
    let start = 7, chunks = 0;
    while (start < text.length) {
      const result = selectStructuredRead(text, index, { start, end: text.length });
      assert.ok(result.served && result.served.end > start);
      assert.ok(result.served.end - start <= 60_000);
      const end = result.served.end;
      assert.equal(/[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end] ?? ''), false);
      assert.equal(result.documentComplete, false);
      start = end; chunks++;
      assert.ok(chunks < 6);
    }
  });

test('SR1c invalid/missing structure refuses on a clean function input; valid absence is outside', () => {
  const text = 'a'.repeat(60_001), structure = buildSourceStructure(text);
  for (const invalid of [undefined, { ...structure, blocks: [] }, { ...structure, utf16Length: 1 }])
    assert.throws(() => selectStructuredRead(text, invalid as any, { start: 3, end: 10 }), { code: 'source_structure_invalid' });
  for (const requested of [{ start: -1, end: 3 }, { start: 4, end: 4 }, { start: 1.5, end: 3 }, { start: 0, end: Infinity }])
    assert.throws(() => selectStructuredRead(text, structure, requested), { code: 'selector_invalid' });
  assert.equal(selectStructuredRead(text, structure, { start: text.length, end: text.length + 10 }).outcome, 'outside');
});

for (const count of [1, 2, 3, 4]) for (const at of [0, count - 1])
  test(`SR1c outcome 5: ${count} paragraphs, hit ${at}, same section`, () => {
    const blocks = Array.from({ length: count }, (_, i) => `${i === at ? 'Needle' : 'normal'}${'x'.repeat(204)}\n`);
    const text = '# Part\n' + blocks.join('\n') + '# Boundary\nDo not include this.\n';
    const result = searchStructuredSource(text, buildSourceStructure(text), 'needle');
    assert.equal(result.delivered, 1);
    const from = at === count - 1 ? Math.max(0, at - 2) : Math.max(0, at - 1);
    const to = at === 0 ? Math.min(count - 1, at + 2) : Math.min(count - 1, at + 1);
    assert.equal(result.fragments[0]!.text, blocks.slice(from, to + 1).join('\n'));
    assert.equal(result.fragments[0]!.heading?.text, '# Part\n');
    assert.deepEqual(result.fragments[0]!.sectionPath[0]!.range, { start: 0, end: 7 });
  });

for (const length of [199, 200]) test(`SR1c ${length} block merge threshold`, () => {
  const first = 'Needle' + 'a'.repeat(length - 7) + '\n';
  const blocks = [first, ...['b', 'c', 'd'].map(char => char.repeat(201) + '\n')];
  const text = '# Part\n' + blocks.join('\n');
  const result = searchStructuredSource(text, buildSourceStructure(text), 'Needle').fragments[0]!;
  assert.equal(result.text, blocks.slice(0, length === 199 ? 4 : 3).join('\n'));
});

for (const length of [5_000, 5_001]) test(`SR1c ${length} main paragraph threshold`, () => {
  const main = 'a'.repeat(2_500) + 'Needle' + 'b'.repeat(length - 2_507) + '\n';
  const text = '# Part\n' + 'before'.repeat(40) + '\n\n' + main + '\n' + 'after'.repeat(50) + '\n';
  const result = searchStructuredSource(text, buildSourceStructure(text), 'Needle').fragments[0]!;
  assert.ok(result.text.includes('Needle'));
  if (length === 5_001) {
    assert.ok(result.text.length <= 4_006); assert.equal(result.sentenceSplit, true);
    assert.ok(result.range.start >= text.indexOf('Needle') - 2_000);
    assert.ok(result.range.end <= text.indexOf('Needle') + 6 + 2_000);
  } else assert.ok(result.text.includes('before') && result.text.includes('after'));
});

test('SR1c fenced code prevents short-paragraph merging and repeated child headings stay distinct', () => {
  const text = '# Parent\nFirst.\n\n```\nNeedle\n```\n\nLast.\n## Same\nNeedle child one.\n## Same\nNeedle child two.\n';
  const result = searchStructuredSource(text, buildSourceStructure(text), 'Needle');
  assert.equal(result.delivered, 3);
  assert.ok(result.fragments[0]!.range.end <= text.indexOf('## Same'));
  assert.notEqual(result.fragments[1]!.sectionId, result.fragments[2]!.sectionId);
  assert.deepEqual(result.fragments[1]!.sectionPath.map(row => row.title), ['Parent', 'Same']);
  for (const fragment of result.fragments) assert.equal(fragment.text, text.slice(fragment.range.start, fragment.range.end));
});

for (const count of [10, 11]) test(`SR1c outcome 6: ${count} disjoint fragments`, () => {
  const text = Array.from({ length: count }, (_, i) => `# Section ${i}\nNeedle ${'a'.repeat(220)}\n`).join('');
  const result = searchStructuredSource(text, buildSourceStructure(text), 'Needle');
  assert.equal(result.found, count); assert.equal(result.delivered, 10);
  assert.equal(result.truncated, count > 10); assert.equal(result.hasMore, count > 10);
});

for (const length of [50_000, 50_001]) test(`SR1c outcome 6: ${length} merged body is capped before display`, () => {
  const block = 'Needle ' + 'a'.repeat(990) + '\n\n';
  const text = block.repeat(Math.floor(length / block.length)) + 'Needle ' + 'x'.repeat(length % block.length - 7);
  assert.equal(text.length, length);
  const result = searchStructuredSource(text, buildSourceStructure(text), 'Needle');
  assert.equal(result.delivered, 1); assert.ok(result.displayedChars <= 50_000);
  assert.equal(result.truncated, length > 50_000);
});

test('SR1c Unicode matcher returns original offsets after dotted capital I and before emoji', () => {
  const text = '# Part\nİİİ before NeedLE 😀 after.\n';
  const result = searchStructuredSource(text, buildSourceStructure(text), 'needle');
  assert.equal(result.fragments[0]!.matchOffsets[0], text.indexOf('NeedLE'));
  assert.equal(text.slice(result.fragments[0]!.matches[0]!.start, result.fragments[0]!.matches[0]!.end), 'NeedLE');
});

test('SR1c dense matches merge before materialization and keep the same bounded exact slice', () => {
  const text = '# Dense\n' + 'a '.repeat(50_000);
  const result = searchStructuredSource(text, buildSourceStructure(text), 'a');
  assert.equal(result.found, 50_000); assert.equal(result.delivered, 1);
  assert.ok(result.displayedChars <= 50_000); assert.equal(result.hasMore, true);
  const fragment = result.fragments[0]!;
  assert.equal(fragment.text, text.slice(fragment.range.start, fragment.range.end));
  assert.ok(fragment.matchOffsets.every(offset => offset >= fragment.range.start && offset < fragment.range.end));
});

test('SR1c R1 later paragraph retains only the near edge of its long predecessor', () => {
  const text = '# Section\n' + ['Needle', 'Needle', 'Needle'].join('x'.repeat(5_000))
    + '\n\nNeedle ' + 'last '.repeat(50);
  const result = searchStructuredSource(text, buildSourceStructure(text), 'Needle');
  assert.equal(result.found, 4); assert.equal(result.delivered, 3);
  assert.equal(result.hasMore, false);
  assert.ok(result.fragments.at(-1)!.text.includes('last '));
  assert.equal(result.fragments.reduce((n, fragment) => n + fragment.matchOffsets.length, 0), 4);
  for (const fragment of result.fragments) assert.equal(fragment.text, text.slice(fragment.range.start, fragment.range.end));
});

for (const placement of ['before', 'after', 'both', 'first', 'last'] as const)
  test(`SR1c R1 match survives long neighbouring paragraphs: ${placement}`, () => {
    const huge = 'A'.repeat(51_000) + '\n\n', small = 'Context ' + 'x'.repeat(220) + '\n\n';
    const main = 'Needle ' + 'b'.repeat(220) + '\n\n';
    const body = placement === 'first' ? main + huge + small
      : placement === 'last' ? small + huge + main
        : placement === 'before' ? huge + main + small
          : placement === 'after' ? small + main + huge : huge + main + huge;
    const text = '# Section\n' + body + '# Next\nNeedle next.\n';
    const found = searchStructuredSource(text, buildSourceStructure(text), 'Needle');
    assert.equal(found.found, 2); assert.equal(found.delivered, 2); assert.equal(found.hasMore, false);
    const first = found.fragments[0]!;
    assert.ok(first.text.includes(main.trimEnd())); assert.ok(first.range.start <= text.indexOf('Needle'));
    assert.ok(first.range.end >= text.indexOf('Needle') + main.trimEnd().length);
    assert.ok(first.text.length < 5_000, 'long neighbouring body yields only its near edge');
    for (const fragment of found.fragments) assert.equal(fragment.text, text.slice(fragment.range.start, fragment.range.end));
  });

test('SR1c R1 mixed budget trims either side of a primary paragraph, and does not stop at an oversized neighbour', () => {
  const text = '# Section\n' + 'A'.repeat(4_000) + '\n\nNeedle ' + 'b'.repeat(220) + '\n\n' + 'C'.repeat(4_000);
  const result = searchStructuredSource(text, buildSourceStructure(text), 'Needle', 10, 1_000);
  assert.equal(result.delivered, 1); assert.ok(result.fragments[0]!.text.includes('Needle ' + 'b'.repeat(220)));
  assert.ok(result.displayedChars <= 1_000); assert.equal(result.hasMore, true);
});

for (const edge of ['start', 'middle', 'end'] as const)
  test(`SR1c R1 huge primary paragraph keeps match at ${edge} and ignores distant neighbours`, () => {
    const main = edge === 'start' ? 'Needle' + 'x'.repeat(51_000)
      : edge === 'end' ? 'x'.repeat(51_000) + 'Needle' : 'x'.repeat(25_500) + 'Needle' + 'x'.repeat(25_500);
    const text = '# Section\n' + 'Before'.repeat(10_000) + '\n\n' + main + '\n\n' + 'After'.repeat(12_000);
    const found = searchStructuredSource(text, buildSourceStructure(text), 'Needle');
    assert.equal(found.delivered, 1); assert.equal(found.found, 1);
    assert.ok(found.fragments[0]!.text.includes('Needle')); assert.ok(found.fragments[0]!.text.length <= 4_006);
  });
