import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { ProductEngine, type Project } from "./product/engine.js";
import { Chat } from "./product/chat.js";
import { EngineError, requireCondition } from "./errors.js";
import { executablePath } from "./runtime/environment.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../public");
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > 6_000_000) throw new EngineError("body_too_large", "Request exceeds the size limit"); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new EngineError("json_invalid", "Request must be JSON"); }
}
function respond(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(data));
}
/** The owner bearer lives only in the HttpOnly SameSite=Strict cookie scoped to /api/owner — never in a body or header. */
function ownerBearer(request: IncomingMessage): string | null {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "omg-owner") return rest.join("=") || null;
  }
  return null;
}
export function createProductServer(engine: ProductEngine) {
  const token = randomBytes(32).toString("hex"); const chat = new Chat(engine.store, engine.environments);
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY"); response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
    try {
      const port = (server.address() as { port: number }).port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      requireCondition(hosts.includes(request.headers.host ?? ""), "host_forbidden", "Use the local application address");
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (request.headers.origin) requireCondition(request.headers.origin === `http://${request.headers.host}`, "origin_forbidden", "Cross-origin requests are forbidden");
      if (url.pathname === "/" && request.method === "GET") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(readFileSync(resolve(ROOT, "index.html"), "utf8").replace("__OMG_TOKEN__", "")); return;
      }
      if (["/app.js", "/app.css"].includes(url.pathname) && request.method === "GET") {
        response.writeHead(200, { "Content-Type": url.pathname.endsWith("css") ? "text/css" : "text/javascript" });
        response.end(readFileSync(resolve(ROOT, url.pathname.slice(1)))); return;
      }
      const supplied = request.headers['x-omg-token'];
      requireCondition(typeof supplied === "string" && /^[a-f0-9]{64}$/.test(supplied) && timingSafeEqual(Buffer.from(supplied), Buffer.from(token)), "session_forbidden", "Open the connection link printed by the local engine");
      // H2.0 (№1353/№2719): the owner session is a separate trust boundary. The general token only reaches the
      // one-time invitation exchange; owner authority comes solely from the bearer cookie scoped to /api/owner.
      if (url.pathname === "/api/owner/session" && request.method === "POST") {
        requireCondition(request.headers.origin === `http://${request.headers.host}`, "origin_forbidden",
          "Owner requests need the exact local origin");
        const input = await body(request) as { project?: unknown; invitation?: unknown };
        requireCondition(input && typeof input === "object" && typeof input.project === "string"
          && typeof input.invitation === "string" && Object.keys(input).sort().join(",") === "invitation,project",
          "command_invalid", "Owner login needs the project and the invitation secret");
        const exchanged = engine.ownerSessionExchange({ project: input.project, invitation: input.invitation });
        if (!exchanged.ok) throw new EngineError(exchanged.refusal.code, exchanged.refusal.message, exchanged.refusal.at);
        const secure = (request.socket as { encrypted?: boolean }).encrypted === true ? "; Secure" : "";
        response.setHeader("Set-Cookie",
          `omg-owner=${exchanged.value.bearer}; HttpOnly; SameSite=Strict; Path=/api/owner; Max-Age=1800${secure}`);
        respond(response, 200, { session: exchanged.value.session, expiresAt: exchanged.value.expiresAt }); return;
      }
      if (url.pathname.startsWith("/api/owner/")) {
        // Owner-mutating requests demand the exact local Origin — the absent-Origin tolerance of ordinary routes does
        // not apply here, and the general token alone is no owner authority.
        requireCondition(request.headers.origin === `http://${request.headers.host}`, "origin_forbidden",
          "Owner requests need the exact local origin");
        requireCondition(request.method === "POST", "owner_request_invalid", "Owner endpoints accept POST only");
        const bearer = ownerBearer(request);
        const authority = engine.ownerAuthority(bearer);
        requireCondition(authority !== null, "owner_session_missing",
          "Owner endpoints need a live owner session — log in with an invitation first");
        if (url.pathname === "/api/owner/logout") {
          const closed = engine.ownerLogout(bearer);
          response.setHeader("Set-Cookie", "omg-owner=; HttpOnly; SameSite=Strict; Path=/api/owner; Max-Age=0");
          if (!closed.ok) throw new EngineError(closed.refusal.code, closed.refusal.message, closed.refusal.at);
          respond(response, 200, { closed: closed.value.session }); return;
        }
        if (url.pathname === "/api/owner/decision") {
          const decided = engine.ownerDecision(authority, await body(request));
          if (!decided.ok) throw new EngineError(decided.refusal.code, decided.refusal.message, decided.refusal.at);
          respond(response, 200, decided.value); return;
        }
        respond(response, 404, { error: "not_found", message: "Route not found" }); return;
      }
      if (url.pathname === "/api/projects" && request.method === "GET") { respond(response, 200, engine.store.list<Project>("project")); return; }
      if (url.pathname === "/api/project" && request.method === "GET") { respond(response, 200, engine.projection(url.searchParams.get("id") ?? "")); return; }
      if (url.pathname === "/api/command" && request.method === "POST") { respond(response, 200, await engine.execute(await body(request))); return; }
      if (url.pathname === "/api/chat" && request.method === "POST") {
        const input = await body(request) as { project: string; message: string };
        requireCondition(input && typeof input.project === "string" && typeof input.message === "string"
          && Object.keys(input).sort().join(",") === "message,project", "command_invalid", "Chat needs a project and message");
        const view = engine.projection(input.project);
        respond(response, 200, await chat.send(input.project, input.message, { title: view.project.value.title,
          stages: view.stages.map(item => ({ stage: item.stage, state: item.state, findings: item.findings })) })); return;
      }
      if (url.pathname === "/api/directories" && request.method === "GET") {
        const path = resolve(url.searchParams.get("path") ?? homedir());
        respond(response, 200, { path, parent: dirname(path), directories: readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith(".")).map(entry => ({ name: entry.name, path: resolve(path, entry.name) })) }); return;
      }
      if (url.pathname === "/api/providers" && request.method === "GET") {
        let available = true; try { executablePath({ executable: "codex", args: [] }, process.cwd()); } catch { available = false; }
        let models: { id: string; label: string }[] = [];
        try { const cache = JSON.parse(readFileSync(resolve(homedir(), ".codex/models_cache.json"), "utf8")); models = cache.models.filter((model: { slug: unknown }) => typeof model.slug === "string").map((model: { slug: string; display_name?: string }) => ({ id: model.slug, label: model.display_name ?? model.slug })); } catch { /* manual model entry remains available */ }
        respond(response, 200, [{ id: "codex", label: "Codex CLI", available, models,
          command: { executable: process.execPath, args: [fileURLToPath(new URL("./adapters/codex-stdio.js", import.meta.url))] } }]); return;
      }
      respond(response, 404, { error: "not_found", message: "Route not found" });
    } catch (error) {
      const code = error instanceof EngineError ? error.code : "request_failed";
      respond(response, ["host_forbidden", "origin_forbidden", "session_forbidden"].includes(code)
        || code.startsWith("owner_session_") || code.startsWith("owner_authority_")
        || code.startsWith("owner_invitation_") ? 403 : 400,
        { error: code, message: error instanceof Error ? error.message : "Request failed", details: error instanceof EngineError ? error.details : null });
    }
  });
  return Object.assign(server, { accessToken: token });
}
