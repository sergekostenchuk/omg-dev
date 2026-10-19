import test from 'node:test';
import assert from 'node:assert/strict';
import { type OmModelCall, runModelCall } from '../src/om/model-call.js';
import { Store } from '../src/storage/store.js';
import { reference } from '../src/pipeline/contracts.js';
import { writeQuestionPacket } from '../src/om/question-packet.js';
import { seriesRequestOf } from '../src/om/series.js';
import { recordCall } from '../src/om/call-record.js';
import { closeAttempt } from '../src/om/repeat-gate.js';
import { completionE1, completionSnapshot, e4Fact, e4Fixture, e4Node, usage, valueOf } from './om-model-call-fixture.js';



// №1601: the role is a set before claim, and exact physical evidence selects one role afterwards.
test('3 H1.0b staged ordinary roles agree at cessation, historical reading and physical entry', async t => {
  const { prepareCompletionCause, readCompletionCause, writeCompletionCessation, readCompletionCessationAt } = await import('../src/om/model-call.js');
  for (const kind of ['fact', 'node'] as const) for (const stage of ['E2', 'E1', 'claim', 'received'] as const)
    for (const changed of ['implementer', 'reviewer', 'both', 'common', 'none'] as const)
      for (const selected of (stage === 'claim' || stage === 'received' ? ['implementer', 'reviewer'] as const : [changed === 'implementer' ? 'reviewer' : 'implementer'] as const))
        await t.test(`${kind}/${stage}/${changed}/${selected}`, async child => {
          const f = e4Fixture(child, kind, 100_000, 0, 5000, true);
          f.steps([{ research: kind === 'fact' ? e4Fact(f) : e4Node(f), usage }]);
          const request = { ...f.request, role: selected };
          if (stage !== 'E2') valueOf(recordCall(f.store, f.project, completionE1(f)));
          if (stage === 'claim' || stage === 'received') {
            const write = f.store.writeMany.bind(f.store); let stopped = false;
            f.store.writeMany = ((writes, guards) => {
              const rows = write(writes, guards);
              if (!stopped && writes.some(row => row.kind === 'model-call'
                && (row.value as OmModelCall).om?.application === (stage === 'claim' ? 'running' : 'received'))) {
                stopped = true; throw new Error('role matrix durable boundary');
              }
              return rows;
            }) as Store['writeMany'];
            try { await assert.rejects(runModelCall(f.store, request), /role matrix durable boundary/); }
            finally { f.store.writeMany = write; }
            assert.equal(stopped, true);
          }
          const work = completionSnapshot(f), assignment = work.assignments.find(row => row.value.kind === (stage === 'E2' ? 'root' : 'part'))!;
          const { projectId: _project, ...config } = structuredClone(f.configured.value);
          if (changed === 'implementer' || changed === 'both') config.implementer.model = 'changed-implementer';
          if (changed === 'reviewer' || changed === 'both') config.reviewer.model = 'changed-reviewer';
          if (changed === 'common') config.timeoutMs += 1000;
          if (changed === 'none') config.fullCheck.args = ['-v'];
          const replacement = f.engine.environments.configure(f.project, config, f.configured.revision);
          const blocks = stage !== 'E2' && (changed === 'common' || changed === 'both'
            || ((stage === 'claim' || stage === 'received') && changed === selected));
          f.restart();
          const proof = valueOf(prepareCompletionCause(f.store, f.project, reference(assignment))).cause;
          assert.equal(proof !== null, blocks);
          if (proof) {
            assert.equal(proof.kind, 'required-record-replaced');
            if (proof.kind !== 'required-record-replaced' || proof.prerequisite.kind !== 'environment') assert.fail('Environment cause');
            assert.equal(proof.prerequisite.role, stage === 'E1' ? null : selected);
            valueOf(readCompletionCause(f.store, f.project, reference(assignment), proof));
            assert.equal(readCompletionCause(f.store, f.project, reference(assignment), {
              ...proof, prerequisite: { ...proof.prerequisite, role: stage === 'E1' ? 'implementer' : null } }).ok, false, 'A caller cannot select another stage for the saved cause');
          } else if (stage !== 'E2') {
            const physical = f.store.list<OmModelCall>('model-call')[0];
            const falseCause = { kind: 'required-record-replaced' as const, prerequisite: { kind: 'environment' as const,
              source: reference(f.configured), context: assignment.value.source,
              physical: physical ? reference(f.store.get(physical.id, 1)!) : null,
              role: stage === 'E1' ? null : selected }, replacement: reference(replacement), proof: null };
            assert.equal(readCompletionCause(f.store, f.project, reference(assignment), falseCause).ok, false);
            if (stage === 'E1' && (changed === 'implementer' || changed === 'reviewer'))
              assert.equal(readCompletionCause(f.store, f.project, reference(assignment), {
                ...falseCause, prerequisite: { ...falseCause.prerequisite, role: changed } }).ok, false, 'The previous assumed-role proof must fail at historical reading too');
          }
          const before = f.store.list(), ceaseRequest = { project: f.project, binding: reference(work.binding), assignment: reference(assignment) };
          const ceased = writeCompletionCessation(f.store, ceaseRequest);
          assert.equal(ceased.ok, blocks && stage !== 'claim');
          if (ceased.ok) {
            assert.equal(ceased.value.value.disposition, stage === 'received' ? 'branch-ceased' : 'not-dispatched');
            f.environment(); f.restart();
            valueOf(readCompletionCause(f.store, f.project, reference(assignment), proof!));
            assert.deepEqual(valueOf(readCompletionCessationAt(f.store, f.project, reference(ceased.value))), ceased.value);
            if (stage === 'E1') {
              const closed = closeAttempt(f.store, { ...seriesRequestOf(f.series.value), attempt: 1,
                outcome: { reason: 'interrupted', accepting: [], cancelling: [], refusals: [] } });
              if (kind === 'fact') valueOf(closed);
              else assert.equal(closed.ok, false, 'A stopped MC2 part does not manufacture the still-missing assembly disposition');
            }
            const closedWork = f.store.get(work.work.id), closedSeries = f.store.get(f.series.id);
            const repeated = await runModelCall(f.store, request); assert.equal(repeated.ok, false);
            if (!repeated.ok) assert.equal(repeated.refusal.code, 'completion_ceased');
            assert.deepEqual(f.store.get(work.work.id), closedWork); assert.deepEqual(f.store.get(f.series.id), closedSeries);
            // The first replay may settle the exact paid receipt after the simulated stop; subsequent reads are inert.
            const history = f.store.list(); f.restart();
            assert.equal((await runModelCall(f.store, request)).ok, false); assert.deepEqual(f.store.list(), history);
            assert.equal(f.sent().length, stage === 'received' ? 1 : 0);
          } else {
            assert.deepEqual(f.store.list(), before);
            if (stage === 'claim') {
              assert.equal(ceased.refusal.code, blocks ? 'completion_claim_exists' : 'completion_cause_unproved');
              assert.equal((await runModelCall(f.store, request)).ok, false); assert.equal(f.sent().length, 0);
              if (proof) { f.environment(); f.restart(); valueOf(readCompletionCause(f.store, f.project, reference(assignment), proof)); }
            } else {
              assert.equal(ceased.refusal.code, 'completion_cause_unproved');
              let executable = request;
              if (stage === 'E2') {
                // Before the first E1 this is still a candidate, not an immutable selected plan.
                const packet = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(replacement) })).record;
                executable = { ...request, packet: reference(packet), dispatch: { ...request.dispatch, config: reference(replacement) } };
              } else if (stage === 'E1') {
                assert.equal(closeAttempt(f.store, { ...seriesRequestOf(f.series.value), attempt: 1,
                  outcome: { reason: 'interrupted', accepting: [], cancelling: [], refusals: [] } }).ok, false);
              }
              const result = valueOf(await runModelCall(f.store, executable));
              assert.equal(result.record.value.om.application, 'applied');
              if (kind === 'fact') assert.equal(result.outcome?.kind, 'fact-candidates'); else assert.ok(result.part);
              assert.equal(f.store.list('om-completion-cessation').length, 0); assert.equal(f.sent().length, 1);
              const history = f.store.list(); f.restart();
              assert.deepEqual(valueOf(await runModelCall(f.store, executable)).record, result.record);
              assert.deepEqual(f.store.list(), history); assert.equal(f.sent().length, 1);
            }
          }
        });
});

