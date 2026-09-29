// Stub rules of dry-run stage 2: the model "cannot answer" every question packet and cannot settle a stop analysis.
// Anything else (fact assessment, part protocol, an unknown packet) is held, so the driver stops the pass and reports it.
// Usage is reported as unknown (null): the stub makes no claim about tokens.
export default function rules(request) {
  let packet;
  try { packet = JSON.parse(request.prompt); } catch { return { hold: "prompt-not-json" }; }
  const text = request.prompt;
  if (packet.purpose === "stop-analysis" || packet.purpose === "origin-analysis" || text.includes("omg-stop-analysis/v1"))
    return { research: { protocol: "omg-stop-analysis/v1", cause: { kind: "hypothesis",
      text: "Dry run: the stand-in model has no knowledge of this project", sources: [] }, change: null, origin: null } };
  if (Array.isArray(packet.questions) && packet.questions.length && text.includes("omg-answer/v2"))
    return { research: { protocol: "omg-answer/v2", requestId: request.requestId, action: "cannot_answer",
      questionIds: packet.questions.map(question => question.id), reason: "Dry run: the stand-in model cannot answer" } };
  return { hold: `unrecognised:${packet.purpose ?? "-"}:${packet.task ?? "-"}` };
}
