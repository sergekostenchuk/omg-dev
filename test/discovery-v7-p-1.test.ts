import test from 'node:test';
import assert from 'node:assert/strict';
import { hashJson } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import type { Ref } from '../src/pipeline/contracts.js';
import { foldV7Progress, type V7ProgressFoldInput, type V7FoldAttempt } from '../src/discovery/v7-progress.js';

// These are structural arguments of a pure projection. No test creates saved
// paid/accepted records; P.3 supplies the real proof and atomic writer later.
const ref = (id: string): Ref => ({id, revision:1, hash:hashJson({id})});
const content = hashJson({claim:'Same content despite different attempt or assessment identifiers'});
const subject = {project:'p',planAnswer:ref('plan-answer:p:1'),planQuestionId:'q'};
const attempt = (number:number, contentKeys:string[]=[]): V7FoldAttempt => ({attempt:ref(`attempt:${number}`),number,contentKeys});
const input = (attempts:V7FoldAttempt[]=[]): V7ProgressFoldInput => ({subject,run:'run:p',previous:null,attempts,accounted:[],knownContentKeys:[]});
function refused(value:unknown, field:string) {
  assert.throws(()=>foldV7Progress(value as V7ProgressFoldInput),(error:unknown)=>{
    assert.ok(error instanceof EngineError);assert.equal(error.code,'discovery_progress_order_invalid');
    assert.equal((error.details as {field:string}).field,field);return true;
  });
}

test('P.1 pure: N=3 counts distinct assessed attempts; the third lack of progress stalls',()=>{
  for(const n of [0,1,2,3,4]) {
    const result=foldV7Progress(input(Array.from({length:n},(_,i)=>attempt(i+1))));
    assert.deepEqual(result.counters,{cursor:n?{run:'run:p',number:n}:null,count:n,streak:n});
    assert.equal(result.stalled,n>=3);assert.deepEqual(result.fresh.map(row=>row.streak),Array.from({length:n},(_,i)=>i+1));
  }
});

test('P.1 pure: new/duplicate/duplicate and the reverse preserve proven order, including identical code keys',()=>{
  for(const semanticDuplicates of [false,true]) {
    const repeated=semanticDuplicates?[]:[content];
    const early=foldV7Progress(input([attempt(1,[content]),attempt(2,repeated),attempt(3,repeated)]));
    const late=foldV7Progress(input([attempt(1,repeated),attempt(2,repeated),attempt(3,[content])]));
    assert.equal(early.counters.count,3);assert.equal(early.counters.streak,2);
    // For semantic duplicate classifications, only the last attempt has content.
    // Identical code keys instead first appear at the first ordered attempt.
    assert.equal(late.counters.streak,semanticDuplicates?0:2);
    assert.equal(early.fresh.flatMap(row=>row.contentKeys).length,1);
    assert.equal(late.fresh.flatMap(row=>row.contentKeys).length,1);
  }
  const reverse=foldV7Progress(input([attempt(1),attempt(2),attempt(3,[content])]));
  assert.equal(reverse.counters.streak,0);assert.equal(reverse.stalled,false);
  const repeatedInOne=foldV7Progress(input([attempt(1,[content,content])]));
  assert.deepEqual(repeatedInOne.fresh[0]!.contentKeys,[content]);
});

test('P.1 pure: a repeated assessment and an overlapping packet add zero counts for exact prior accounts',()=>{
  const rows=[attempt(1,[content]),attempt(2,[content]),attempt(3,[content])];
  const first=foldV7Progress(input(rows));
  const replay:V7ProgressFoldInput={...input(rows),previous:{subject,counters:first.counters},
    accounted:rows.map(row=>row.attempt),knownContentKeys:[content]};
  assert.deepEqual(foldV7Progress(replay),{counters:first.counters,stalled:false,fresh:[]});
  for(let n=0;n<3;n++) assert.equal(foldV7Progress(replay).counters.count,3);
  const overlap=foldV7Progress({...replay,attempts:[rows[2]!,attempt(4,[content])],accounted:[rows[2]!.attempt]});
  assert.deepEqual(overlap.counters,{cursor:{run:'run:p',number:4},count:4,streak:3});assert.equal(overlap.stalled,true);
  assert.equal(overlap.fresh.length,1);assert.deepEqual(overlap.fresh[0]!.contentKeys,[]);
  const newContent=foldV7Progress({...input([attempt(8,[hashJson({different:true})])]),
    previous:{subject,counters:overlap.counters},knownContentKeys:[content]});
  assert.deepEqual(newContent.counters,{cursor:{run:'run:p',number:8},count:5,streak:0});
  assert.equal(newContent.stalled,false,'positions of other subjects may occupy the intervening managed turns');
});

test('P.1 pure: replay keeps its saved cursor even if the assessed subpacket ends earlier',()=>{
  const before={cursor:{run:'run:p',number:9},count:3,streak:2};
  const row=attempt(2,[content]);
  assert.deepEqual(foldV7Progress({...input([row]),previous:{subject,counters:before},accounted:[row.attempt],knownContentKeys:[content]}),
    {counters:before,stalled:false,fresh:[]});
});

test('P.1 pure: missing fields, coercion, forged order and foreign prefix refuse at exact addresses',async t=>{
  const seeded=():any=>({...input([attempt(2)]),previous:{subject,counters:{cursor:{run:'run:p',number:1},count:1,streak:1}}});
  const cases:[string,()=>any,string][]=[];
  for(const key of ['subject','run','previous','attempts','accounted','knownContentKeys'])
    cases.push([`missing ${key}`,()=>{const v:any=input();delete v[key];return v;},'input']);
  for(const key of ['project','planAnswer','planQuestionId'])
    cases.push([`missing subject ${key}`,()=>{const v:any=structuredClone(input());delete v.subject[key];return v;},'subject']);
  for(const key of ['attempt','number','contentKeys'])
    cases.push([`missing row ${key}`,()=>{const v:any=input([attempt(1)]);delete v.attempts[0][key];return v;},'attempts.0']);
  for(const key of ['subject','counters'])
    cases.push([`missing previous ${key}`,()=>{const v=seeded();delete v.previous[key];return v;},'previous']);
  for(const key of ['cursor','count','streak'])
    cases.push([`missing counter ${key}`,()=>{const v=seeded();delete v.previous.counters[key];return v;},'previous.counters']);
  for(const key of ['run','number'])
    cases.push([`missing cursor ${key}`,()=>{const v=seeded();delete v.previous.counters.cursor[key];return v;},'previous.counters.cursor']);
  const bad:[string,()=>any,string][]=[
    ['null input',()=>null,'input'],
    ['null rows',()=>({...input(),attempts:null}),'attempts'],
    ['null accounts',()=>({...input(),accounted:null}),'accounted'],
    ['missing row key list',()=>({...input([attempt(1)]),attempts:[{...attempt(1),contentKeys:null}]}),'attempts.0.contentKeys'],
    ['malformed key',()=>input([attempt(1,['not-a-hash'])]),'attempts.0.contentKeys'],
    ['sparse keys',()=>input([attempt(1,Array(1))]),'attempts.0.contentKeys'],
    ['sparse rows',()=>({...input(),attempts:Array(1)}),'attempts.0'],
    ['string position',()=>input([{...attempt(1),number:'1'} as any]),'attempts.0'],
    ['zero position',()=>input([attempt(0)]),'attempts.0'],
    ['unordered',()=>input([attempt(2),attempt(1)]),'attempts.1'],
    ['repeated position',()=>input([attempt(1),attempt(1)]),'attempts.1'],
    ['same attempt at another position',()=>input([attempt(1),{...attempt(2),attempt:ref('attempt:1')}]),'attempts.1.attempt'],
    ['unaccounted old attempt',()=>({...seeded(),attempts:[attempt(1)]}),'cursor'],
    ['foreign account',()=>({...seeded(),accounted:[ref('other')]}),'accounted.0'],
    ['null account',()=>({...seeded(),accounted:[null]}),'accounted.0'],
    ['account ahead of prefix',()=>({...seeded(),accounted:[ref('attempt:2')]}),'accounted.0'],
    ['changed account hash',()=>({...seeded(),attempts:[attempt(1)],accounted:[{...ref('attempt:1'),hash:'0'.repeat(64)}]}),'accounted.0'],
    ['duplicate account',()=>({...seeded(),attempts:[attempt(1)],accounted:[ref('attempt:1'),ref('attempt:1')]}),'accounted.1'],
    ['account without previous',()=>({...input([attempt(1)]),accounted:[ref('attempt:1')]}),'previous'],
    ['keys without previous',()=>({...input(),knownContentKeys:[content]}),'previous'],
    ['foreign project',()=>{const v=seeded();v.previous.subject={...subject,project:'foreign'};return v;},'previous.subject'],
    ['new edition',()=>{const v=seeded();v.previous.subject={...subject,planAnswer:{...subject.planAnswer,revision:2}};return v;},'previous.subject'],
    ['other question',()=>{const v=seeded();v.previous.subject={...subject,planQuestionId:'other'};return v;},'previous.subject'],
    ['other run',()=>{const v=seeded();v.previous.counters.cursor.run='other';return v;},'previous.counters.cursor'],
    ['counter coercion',()=>{const v=seeded();v.previous.counters.count='1';return v;},'previous.counters'],
    ['negative streak',()=>{const v=seeded();v.previous.counters.streak=-1;return v;},'previous.counters'],
    ['impossible streak',()=>{const v=seeded();v.previous.counters.streak=2;return v;},'previous.counters'],
    ['nonempty prefix without cursor',()=>{const v=seeded();v.previous.counters.cursor=null;return v;},'previous.counters.cursor'],
  ];
  for(const [name,make,field] of [...cases,...bad]) await t.test(name,()=>refused(make(),field));
});

test('P.1 pure: frozen inputs remain unchanged and independent outputs cannot alter later replay',()=>{
  const value=input([attempt(1,[content])]),original=structuredClone(value);
  const freeze=(v:any):void=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}};
  freeze(value);const first=foldV7Progress(value);
  first.fresh[0]!.attempt.hash='0'.repeat(64);first.fresh[0]!.contentKeys.length=0;
  assert.deepEqual(value,original);
  const again=foldV7Progress(value);assert.equal(again.fresh[0]!.attempt.hash,ref('attempt:1').hash);
  assert.deepEqual(again.fresh[0]!.contentKeys,[content]);assert.equal(again.counters.count,1);
});
