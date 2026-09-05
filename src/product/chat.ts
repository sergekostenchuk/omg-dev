import { randomUUID } from "node:crypto";
import { Store, type Revision } from "../storage/store.js";
import { Environments } from "../runtime/environment.js";
import { runProcess } from "../runtime/process.js";
import { reference } from "../pipeline/contracts.js";
import { EngineError, requireCondition } from "../errors.js";

export interface ChatTurn { projectId: string; requestId: string; createdAt: number; message: string; model: string; status: "running" | "completed" | "failed"; text: string; error: string | null }
export class Chat {
  #active = new Set<string>();
  constructor(private readonly store: Store, private readonly environments: Environments) {}
  async send(projectId: string, message: string, context: unknown): Promise<Revision<ChatTurn>> {
    requireCondition(typeof message === "string" && message.trim() && message.length <= 30_000, "message_invalid", "Enter a nonempty message within the size limit");
    requireCondition(!this.#active.has(projectId), "chat_busy", "Wait for the current response");
    const environment = this.environments.get(projectId);
    const requestId = randomUUID(); const id = `chat:${projectId}:${requestId}`;
    const turn: ChatTurn = { projectId, requestId, createdAt: Date.now(), message, model: environment.value.implementer.model, status: "running", text: "", error: null };
    this.store.write({ id, kind: "chat", expected: 0, value: turn }); this.#active.add(projectId);
    try {
      const history = this.store.list<ChatTurn>("chat").filter(item => item.value.projectId === projectId && item.value.status === "completed").sort((a,b) => a.value.createdAt - b.value.createdAt).slice(-12).map(item => ({ user: item.value.message, assistant: item.value.text }));
      const request = { protocol: "omg-agent/v1", requestId, mode: "chat", model: turn.model, effort: environment.value.implementer.effort,
        ...(environment.value.implementer.speed ? { speed: environment.value.implementer.speed } : {}),
        prompt: JSON.stringify({ message, history, project: context }), environment: reference(environment) };
      const result = await runProcess(environment.value.implementer.command, environment.value.workspace, JSON.stringify(request), environment.value.timeoutMs);
      requireCondition(result.exitCode === 0, "provider_failed", result.stderr.slice(-2000) || "Selected provider failed");
      const answer = JSON.parse(result.stdout) as { protocol: string; requestId: string; text: string };
      requireCondition(answer.protocol === request.protocol && answer.requestId === requestId && typeof answer.text === "string" && answer.text.trim(), "provider_response_invalid", "Provider response is missing or belongs to another request");
      return this.store.write<ChatTurn>({ id, kind: "chat", expected: 1, value: { ...turn, status: "completed", text: answer.text } });
    } catch (error) {
      return this.store.write<ChatTurn>({ id, kind: "chat", expected: 1, value: { ...turn, status: "failed", error: error instanceof EngineError ? error.code : "provider_response_invalid" } });
    } finally { this.#active.delete(projectId); }
  }
}
