import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createMcpServer } from "../../src/mcp-server.js";
import { ConnectorError } from "../../src/errors.js";
import { UserStore, type User } from "./users.js";
import type { RuntimePool } from "./runtime.js";

export interface WebOptions { publicUrl: string; publicDir: string; users: UserStore; runtimes: Pick<RuntimePool, "get" | "release">; allowHttpIp?: boolean }
type Session = { userId: string; csrf: string; expires: number };
class HttpError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
function json(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); }
async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new HttpError(415, "CONTENT_TYPE", "Ожидается JSON.");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 65_536) throw new HttpError(413, "BODY_TOO_LARGE", "Слишком большой запрос.");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "INVALID_INPUT", "Некорректный JSON."); }
}
const browserInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), x: z.number().min(0).max(1439), y: z.number().min(0).max(999) }).strict(),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(1000) }).strict(),
  z.object({ type: z.literal("key"), key: z.enum(["Enter", "Tab", "Shift+Tab", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Control+A", "Escape", "Home", "End"]) }).strict(),
  z.object({ type: z.literal("scroll"), delta: z.number().min(-1000).max(1000) }).strict(),
]);
const accountSchema = z.object({ username: z.string().regex(/^[a-zA-Z0-9_.-]{3,64}$/), password: z.string().min(16).max(512) }).strict();

export function validatePublicUrl(value: string, allowHttpIp = false): URL {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("WEB_PUBLIC_URL должен содержать только протокол, адрес и порт.");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const ip = isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || (allowHttpIp && ip)))) {
    throw new Error("Используйте HTTPS. HTTP по IP разрешается только при WEB_ALLOW_HTTP_IP=true; HTTP-домены не поддерживаются.");
  }
  return url;
}

export function createWebServer(options: WebOptions) {
  const publicUrl = validatePublicUrl(options.publicUrl, options.allowHttpIp);
  const sessions = new Map<string, Session>();
  const attempts = new Map<string, { count: number; expires: number }>();
  const requests = new Set<Promise<unknown>>();
  const cookie = (token: string, seconds: number) => `linkedin_web=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${publicUrl.protocol === "https:" ? "; Secure" : ""}`;
  function invalidate(userId: string) { for (const [key, session] of sessions) if (session.userId === userId) sessions.delete(key); }
  const server = createServer((req, res) => {
    const task = (async () => {
      for (const [id, session] of sessions) if (session.expires < Date.now()) sessions.delete(id);
      for (const [id, attempt] of attempts) if (attempt.expires < Date.now()) attempts.delete(id);
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });
      if (req.headers.origin && req.headers.origin !== publicUrl.origin) throw new HttpError(403, "ORIGIN", "Запрос с другого сайта запрещён.");
      if (url.pathname === "/mcp") {
        const token = /^Bearer (ln_[a-f0-9]{64})$/.exec(req.headers.authorization ?? "")?.[1];
        const user = token && options.users.tokenUser(token);
        if (!user) { res.setHeader("www-authenticate", 'Bearer realm="linkedin-mcp"'); throw new HttpError(401, "AUTH_REQUIRED", "Требуется персональный MCP-ключ из портала."); }
        if (req.method !== "POST") { res.setHeader("allow", "POST"); throw new HttpError(405, "METHOD_NOT_ALLOWED", "Этот MCP использует Streamable HTTP без состояния транспорта; отправляйте POST."); }
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        const { server: mcp } = createMcpServer(options.runtimes.get(user).client);
        try {
          await mcp.connect(transport);
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
          const response = await transport.handleRequest(new Request(`${publicUrl.origin}/mcp`, { method: "POST", headers, body: JSON.stringify(await body(req)) }));
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.writeHead(response.status);
          res.end(Buffer.from(await response.arrayBuffer()));
        } finally { await mcp.close(); }
        return;
      }
      if (req.method === "GET" && ["/", "/app.js", "/style.css"].includes(url.pathname)) {
        const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const content = await readFile(`${options.publicDir}/${name}`);
        res.writeHead(200, { "content-type": name.endsWith("html") ? "text/html; charset=utf-8" : name.endsWith("js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8" });
        return res.end(content);
      }
      if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "NOT_FOUND", "Страница не найдена.");
      if (req.method === "POST" && req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "ORIGIN", "Запрос с другого сайта запрещён.");
      if (req.method === "POST" && url.pathname === "/api/login") {
        const address = req.socket.remoteAddress ?? "unknown";
        const attempt = attempts.get(address) ?? { count: 0, expires: Date.now() + 300_000 };
        if (attempt.count >= 20 || attempts.size >= 1000) throw new HttpError(429, "RATE_LIMIT", "Слишком много попыток входа. Повторите через 5 минут.");
        const input = z.object({ username: z.string().max(64), password: z.string().max(512) }).strict().parse(await body(req));
        const user = options.users.authenticate(input.username, input.password);
        if (!user) { attempt.count++; attempts.set(address, attempt); throw new HttpError(401, "AUTH_REQUIRED", "Неверный логин или пароль."); }
        if (sessions.size >= 1000) throw new HttpError(429, "RATE_LIMIT", "Лимит активных сессий портала.");
        const token = randomBytes(32).toString("hex");
        const session = { userId: user.id, csrf: randomBytes(32).toString("hex"), expires: Date.now() + 8 * 3_600_000 };
        sessions.set(token, session); res.setHeader("set-cookie", cookie(token, 8 * 3600));
        return json(res, 200, { ok: true, data: { user, csrf: session.csrf, mcpUrl: `${publicUrl.origin}/mcp` } });
      }
      const sessionToken = /(?:^|;\s*)linkedin_web=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
      const session = sessions.get(sessionToken);
      const user = session && options.users.get(session.userId);
      if (!session || !user || user.disabled) throw new HttpError(401, "AUTH_REQUIRED", "Войдите в портал.");
      if (req.method === "POST" && req.headers["x-csrf-token"] !== session.csrf) throw new HttpError(403, "CSRF", "Обновите страницу и повторите запрос.");
      const success = (data: unknown) => json(res, 200, { ok: true, data });
      if (req.method === "GET" && url.pathname === "/api/me") return success({ user, csrf: session.csrf, mcpUrl: `${publicUrl.origin}/mcp` });
      if (req.method === "POST" && url.pathname === "/api/logout") { sessions.delete(sessionToken); res.setHeader("set-cookie", cookie("", 0)); return success({}); }
      if (req.method === "POST" && url.pathname === "/api/password") {
        const input = z.object({ currentPassword: z.string().max(512), password: z.string().min(16).max(512) }).strict().parse(await body(req));
        if (!options.users.authenticate(user.username, input.currentPassword)) throw new HttpError(403, "AUTH_REQUIRED", "Текущий пароль неверен.");
        options.users.update(user.id, { password: input.password }); invalidate(user.id); res.setHeader("set-cookie", cookie("", 0)); return success({});
      }
      if (req.method === "POST" && url.pathname === "/api/token") return success({ token: options.users.rotateToken(user.id), mcpUrl: `${publicUrl.origin}/mcp` });
      if (req.method === "POST" && url.pathname === "/api/token/revoke") { options.users.revokeToken(user.id); return success({}); }
      if (req.method === "POST" && url.pathname === "/api/linkedin/open") { await options.runtimes.get(user).openLogin(); return success({}); }
      if (req.method === "GET" && url.pathname === "/api/linkedin/frame") return success(await options.runtimes.get(user).frame());
      if (req.method === "POST" && url.pathname === "/api/linkedin/input") { await options.runtimes.get(user).input(browserInput.parse(await body(req))); return success({}); }
      if (req.method === "POST" && url.pathname === "/api/linkedin/finish") { await options.runtimes.get(user).finishLogin(); return success({}); }
      if (req.method === "POST" && url.pathname === "/api/linkedin/status") return success(await options.runtimes.get(user).client.sessionStatus());
      if (req.method === "POST" && url.pathname === "/api/linkedin/release") { await options.runtimes.release(user.id); return success({}); }
      if (url.pathname.startsWith("/api/admin/")) {
        if (user.role !== "admin") throw new HttpError(403, "FORBIDDEN", "Только администратор может управлять пользователями.");
        if (req.method === "GET" && url.pathname === "/api/admin/users") return success(options.users.list());
        if (req.method === "POST" && url.pathname === "/api/admin/users") {
          const input = accountSchema.parse(await body(req));
          try { return success(options.users.create(input.username, input.password)); }
          catch { throw new HttpError(409, "USER_EXISTS", "Не удалось создать пользователя. Проверьте уникальность логина."); }
        }
        if (req.method === "POST" && url.pathname === "/api/admin/user") {
          const input = z.object({ id: z.string().uuid(), disabled: z.boolean().optional(), actionMode: z.enum(["review", "execute"]).optional(), password: z.string().min(16).max(512).optional(), release: z.boolean().optional(), revokeToken: z.boolean().optional() }).strict().parse(await body(req));
          const target = options.users.get(input.id);
          if (!target) throw new HttpError(404, "NOT_FOUND", "Пользователь не найден.");
          if (target.role === "admin") throw new HttpError(403, "FORBIDDEN", "Учётная запись администратора защищена от изменения в этом разделе.");
          options.users.update(input.id, { ...(input.disabled === undefined ? {} : { disabled: input.disabled }), ...(input.actionMode === undefined ? {} : { actionMode: input.actionMode }), ...(input.password === undefined ? {} : { password: input.password }) });
          if (input.revokeToken) options.users.revokeToken(input.id);
          if (input.disabled !== undefined || input.password !== undefined) invalidate(input.id);
          if (input.release || input.disabled !== undefined || input.actionMode !== undefined) await options.runtimes.release(input.id);
          return success(options.users.get(input.id));
        }
      }
      throw new HttpError(404, "NOT_FOUND", "Маршрут не найден.");
    })().catch(error => {
      if (res.headersSent) return res.end();
      if (error instanceof z.ZodError) return json(res, 400, { ok: false, error: { code: "INVALID_INPUT", message: error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") } });
      if (error instanceof HttpError) return json(res, error.status, { ok: false, error: { code: error.code, message: error.message } });
      if (error instanceof ConnectorError) return json(res, 409, { ok: false, error: { code: error.code, message: error.message } });
      console.error("Portal request failed", error instanceof Error ? error.name : "Unknown error");
      json(res, 500, { ok: false, error: { code: "INTERNAL", message: "Внутренняя ошибка сервера." } });
    });
    requests.add(task); void task.finally(() => requests.delete(task));
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return { server, async drain() { await Promise.allSettled([...requests]); } };
}
