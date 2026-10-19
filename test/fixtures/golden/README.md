# Current-code sample

Generate from the current checkout with `npm run sample:generate` (Node 22 with `node:sqlite`, Git and installed npm dependencies). Generation never fetches, builds or imports an older commit.

The command captures every regular file below `src/` plus the exact support files listed by `captureInputs` in `scripts/golden-sample.mjs`. Paths and bytes are length-framed into `producerDigest`. The captured files are compiled in a private directory and that isolated build runs the generator; later changes in the checkout cannot become its metadata. `meta.json` records every captured path/hash, toolchain, accepted stage references and the SQLite SHA-256. A changed producer, schema, contract, recipe, bootstrap, adapter, dependency lockfile or compiler configuration requires regeneration.

The recipe drives current `early-stage-run`, native B1/addressing/horizon/frame producers, OM and execution. Its local adapter is a scripted recipe, not a remote model. Proposals pass the ordinary product gates. Execution runs the actual numeric transformation checks in a private Git workspace. No accepted stage, outcome or closure is fabricated or rewritten by SQL.

All Stores and children finish before publication. Only the disposable proof cache is cleared. The producer SQLite is checkpointed, switched to DELETE journal mode, closed, integrity-checked and copied in full. No events, revisions, evidence, receipts or failure history are trimmed. `CURRENT` atomically selects the matching `meta.json`/`state.sqlite` pair. The previous sample directory is removed after replacement; this is one sample, not a collection of eras.

`goldenSample(t)` verifies the input digest, toolchain and SQLite hash on its first use in a process. It retains private verified bytes and creates an independent writable database for each test. The canonical file is never opened by a Store. Missing, stale or altered files fail with the regeneration command, before creating the copy. It does not regenerate implicitly.

## Reproducibility boundary

The recipe and adapter answers are fixed. UUID allocation (including `database_id`) is seeded in the isolated producer before product imports; adapter children explicitly import the same bootstrap. Git dates, identity, hooks/signing and global Git configuration are controlled locally. Wall time has a fixed origin while real elapsed intervals remain available for runtime liveness. Locale/timezone are controlled. The metadata identifies Node, SQLite, TypeScript, Git, OS and architecture.

A second generation is **not promised byte-identical**: elapsed time, process identities, private workspace paths and platform/runtime receipts are real. The guarantee is that the published database was produced and accepted by the exact captured current inputs, and that every consumer copies the exact hashed file. No runtime receipt is normalized to manufacture identical bytes.

## Where it can be used

Use the copy for lower readers of already completed, exact history. A finished sample cannot stand in for an absent record, an unfinished call, a partially built prefix, a race or a fresh acceptance: those states must be built by current producers in the test. External workspaces, Git heads, runtime environment confirmations and public engine/server/CLI task-context are not portable; tests for those own their workspace and current setup. Do not rewrite stored paths or hashes to make a sample appear current.

The `om-answers-gate` pilot uses its existing per-process `seedCopy` of a prefix built by current producers. Its open-prefix mutations need a different state from this completed sample. Both former `7c7d3ccc` calls in `gatePrefix` were replaced by current `preparedFeatures`/`writeRoutes`; no historical executable is involved. The separate tests whose purpose is an old era remain the responsibility of EXCL1 and are excluded from the GS1 timing run.
