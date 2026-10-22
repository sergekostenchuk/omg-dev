/**
 * Allowance for a real child process that is expected to finish. A limit is a ceiling, not a duration: it costs nothing
 * while the machine is idle and only a stuck child waits for it, but under the load of a full run a process that takes a
 * fraction of a second can need seconds. Tests of the limit itself keep their own small values.
 */
export const REAL_PROCESS_TIMEOUT_MS = 30_000;
