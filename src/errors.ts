export class EngineError extends Error {
  constructor(public readonly code: string, message: string, public readonly details: unknown = null) {
    super(message);
    this.name = "EngineError";
  }
}

export function requireCondition(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new EngineError(code, message);
}
