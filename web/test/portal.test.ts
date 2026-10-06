import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UserStore, type User } from "../src/users.js";
import { createWebServer, validatePublicUrl } from "../src/server.js";
import { RuntimePool, type UserRuntime } from "../src/runtime.js";
import type { ConnectorClient } from "../../src/worker/protocol.js";
import { ConnectorError } from "../../src/errors.js";
import { OperationStore } from "../../src/storage/operation-store.js";

const password = "portal-test-password-123";
function temp() { return mkdtempSync(path.join(os.tmpdir(), "linkedin-portal-")); }
function remove(directory: string) {
  const root = path.resolve(os.tmpdir()) + path.sep;
  assert.ok(path.resolve(directory).startsWith(root));
  rmSync(directory, { recursive: true, force: true });
}
async function fixture(settings: { publicUrl?: string; allowHttpIp?: boolean } = {}) {
  const directory = temp();
  const users = new UserStore(path.join(directory, "users.sqlite"));
  const admin = users.create("admin", password, "admin");
  const alice = users.create("alice", password), bob = users.create("bob", password);
  const accessed: string[] = [];
  const runtimes = {
    get(user: User): UserRuntime {
      accessed.push(user.id);
      const client = {
        async health() { return { pid: 1, startedAt: "test", uptimeSeconds: 0, browser: { running: false, pages: 0, roles: [] } }; },
        async sessionStatus() { return { state: "authenticated", url: "https://www.linkedin.com/sales/home", title: user.username, salesNavigatorAvailable: true, actionMode: user.action_mode }; },
        async sendMessage(input: { operationId: string }) { return { status: "preview", operationId: input.operationId, user: user.username }; },
        async getOperation(operationId: string) { if (operationId !== `${user.username}-operation`) throw new ConnectorError("NOT_FOUND", "Not found"); return { id: operationId }; },
      } as unknown as ConnectorClient;
      return { client, async openLogin() {}, async frame() { return { width: 1440, height: 1000, url: user.username, complete: false, image: "test" }; }, async input() {}, async finishLogin() {}, async close() {} };
    },
    async release() {},
  };
  const app = createWebServer({ publicUrl: settings.publicUrl ?? "http://localhost:3000", allowHttpIp: settings.allowHttpIp ?? false, publicDir: path.resolve(import.meta.dirname, "../public"), users, runtimes });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  async function login(username: string) {
    const response = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
    assert.equal(response.status, 200);
    const payload = await response.json() as { data: { csrf: string } };
    return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, "x-csrf-token": payload.data.csrf, "content-type": "application/json" };
  }
  async function post(route: string, headers: Record<string, string>, input: unknown = {}) { return fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(input) }); }
  async function rpc(token: string, method: string, params?: unknown) {
    return post("/mcp", { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) });
  }
  return { users, admin, alice, bob, accessed, base, login, post, rpc, async close() { app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.drain(); users.close(); remove(directory); } };
}

test("personal keys persist as hashes, rotate, and respect account blocking", () => {
  const directory = temp(); let users = new UserStore(path.join(directory, "users.sqlite"));
  try {
    const alice = users.create("alice", password), bob = users.create("bob", password);
    assert.equal(users.authenticate("alice", "wrong"), undefined);
    const old = users.rotateToken(alice.id), bobToken = users.rotateToken(bob.id);
    assert.equal(users.tokenUser(old)?.id, alice.id);
    const token = users.rotateToken(alice.id); assert.equal(users.tokenUser(old), undefined);
    users.close(); users = new UserStore(path.join(directory, "users.sqlite"));
    assert.equal(users.tokenUser(token)?.id, alice.id);
    assert.equal(users.tokenUser(bobToken)?.id, bob.id);
    assert.deepEqual(Object.keys(users.list()[0]!).sort(), ["action_mode", "created_at", "disabled", "id", "role", "username"]);
    users.update(alice.id, { disabled: true }); assert.equal(users.tokenUser(token), undefined); assert.equal(users.authenticate("alice", password), undefined);
    assert.equal(users.tokenUser(bobToken)?.id, bob.id);
  } finally { users.close(); remove(directory); }
});

test("portal authorization, CSRF, origin, and browser account isolation", async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.base}/api/me`)).status, 401);
    assert.equal((await fetch(`${f.base}/.env`)).status, 404);
    const alice = await f.login("alice");
    assert.equal((await fetch(`${f.base}/api/admin/users`, { headers: alice })).status, 403);
    assert.equal((await f.post("/api/token", { ...alice, "x-csrf-token": "wrong" })).status, 403);
    assert.equal((await f.post("/api/token", { ...alice, origin: "https://evil.example" })).status, 403);
    assert.equal((await f.post("/api/linkedin/open", alice)).status, 200);
    const image = await fetch(`${f.base}/api/linkedin/frame`, { headers: alice });
    assert.equal((await image.json() as { data: { url: string } }).data.url, "alice");
    assert.deepEqual(f.accessed, [f.alice.id, f.alice.id]);
    assert.equal((await f.post("/api/linkedin/input", alice, { type: "key", key: "Control+L" })).status, 400);
    assert.equal((await f.post("/api/linkedin/input", alice, { type: "click", x: 1, y: 1, userId: f.bob.id })).status, 400);
    assert.equal((await fetch(`${f.base}/api/jobs`, { headers: alice })).status, 404);
  } finally { await f.close(); }
});

test("administrator creates users, revokes keys and invalidates portal sessions", async () => {
  const f = await fixture();
  try {
    const admin = await f.login("admin"), alice = await f.login("alice");
    const token = f.users.rotateToken(f.alice.id);
    assert.equal((await f.post("/api/admin/users", admin, { username: "charlie", password })).status, 200);
    assert.equal((await f.post("/api/admin/users", admin, { username: "charlie", password })).status, 409);
    assert.equal((await f.post("/api/admin/user", admin, { id: f.alice.id, disabled: true })).status, 200);
    assert.equal((await fetch(`${f.base}/api/me`, { headers: alice })).status, 401);
    assert.equal((await f.rpc(token, "tools/list")).status, 401);
    assert.equal((await f.post("/api/admin/user", admin, { id: f.admin.id, disabled: true })).status, 403);
    assert.equal((await f.post("/api/admin/user", admin, { id: f.alice.id, disabled: false, password: "new-user-password-1234", actionMode: "execute" })).status, 200);
    assert.equal(f.users.authenticate("alice", password), undefined);
    assert.equal(f.users.authenticate("alice", "new-user-password-1234")?.action_mode, "execute");
  } finally { await f.close(); }
});

test("remote MCP negotiates, exposes the same tools, and routes each key to its user", async () => {
  const f = await fixture();
  try {
    const alice = f.users.rotateToken(f.alice.id), bob = f.users.rotateToken(f.bob.id);
    assert.equal((await f.rpc("invalid", "tools/list")).status, 401);
    const initialized = await f.rpc(alice, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "portal-test", version: "1.0" } });
    assert.equal(initialized.status, 200);
    assert.equal((await initialized.json() as { result: { serverInfo: { name: string } } }).result.serverInfo.name, "linkedin-sales-navigator");
    const response = await f.rpc(alice, "tools/list"); assert.equal(response.status, 200);
    const tools = (await response.json() as { result: { tools: { name: string }[] } }).result.tools;
    assert.equal(tools.length, 8); assert.ok(tools.some(t => t.name === "linkedin_search_people"));
    for (const [token, name] of [[alice, "alice"], [bob, "bob"]]) {
      const call = await f.rpc(token!, "tools/call", { name: "linkedin_send_message", arguments: { operationId: "same-id-123", profileUrl: "https://www.linkedin.com/in/example/", text: "Preview", commit: false } });
      assert.equal(call.status, 200);
      assert.equal((await call.json() as { result: { structuredContent: { data: { user: string } } } }).result.structuredContent.data.user, name);
    }
    const other = await f.rpc(alice, "tools/call", { name: "linkedin_get_operation", arguments: { operationId: "bob-operation" } });
    const payload = await other.json() as { result: { isError: boolean; structuredContent: { error: { code: string } } } };
    assert.equal(payload.result.isError, true); assert.equal(payload.result.structuredContent.error.code, "NOT_FOUND");
    f.users.rotateToken(f.alice.id); assert.equal((await f.rpc(alice, "tools/list")).status, 401);
  } finally { await f.close(); }
});

test("real core uses separate operation databases and lazy browsers per user", async () => {
  const directory = temp(), users = new UserStore(path.join(directory, "users.sqlite"));
  const pool = new RuntimePool(directory, directory, 2);
  try {
    const alice = users.create("alice", password), bob = users.create("bob", password);
    const a = pool.get(alice), b = pool.get(bob);
    assert.notEqual(a, b);
    assert.equal((await a.client.health()).browser.running, false);
    const aStore = new OperationStore(path.join(directory, "users", alice.id, "operations.sqlite"));
    const bStore = new OperationStore(path.join(directory, "users", bob.id, "operations.sqlite"));
    aStore.reserve("shared-operation", "send_message", { owner: "alice" });
    bStore.reserve("shared-operation", "send_message", { owner: "bob" });
    aStore.close(); bStore.close();
    assert.equal((await a.client.getOperation("shared-operation")).request.owner, "alice");
    assert.equal((await b.client.getOperation("shared-operation")).request.owner, "bob");
    const charlie = users.create("charlie", password);
    assert.throws(() => pool.get(charlie), /лимит/i);
    await pool.release(alice.id); assert.ok(pool.get(charlie));
    await pool.release(charlie.id);
    assert.equal((await pool.get(alice).client.health()).browser.running, false);
    assert.equal((await pool.get(alice).client.getOperation("shared-operation")).request.owner, "alice");
  } finally { await pool.close(); users.close(); remove(directory); }
});

test("HTTPS IP works by default, while remote HTTP requires an explicit IP-only opt-in", () => {
  assert.equal(validatePublicUrl("https://203.0.113.10:8443").origin, "https://203.0.113.10:8443");
  assert.equal(validatePublicUrl("https://[2001:db8::10]").origin, "https://[2001:db8::10]");
  assert.equal(validatePublicUrl("http://localhost:3000").origin, "http://localhost:3000");
  assert.throws(() => validatePublicUrl("http://203.0.113.10:3081"), /WEB_ALLOW_HTTP_IP/);
  assert.throws(() => validatePublicUrl("http://[2001:db8::10]:3081"), /WEB_ALLOW_HTTP_IP/);
  assert.equal(validatePublicUrl("http://203.0.113.10:3081", true).origin, "http://203.0.113.10:3081");
  assert.equal(validatePublicUrl("http://[2001:db8::10]:3081", true).origin, "http://[2001:db8::10]:3081");
  for (const value of ["http://example.com", "ftp://203.0.113.10", "https://user:password@203.0.113.10", "https://203.0.113.10/subpath", "https://203.0.113.10/?key=secret"]) {
    assert.throws(() => validatePublicUrl(value, true));
  }
});

test("HTTP IP login generates the correct MCP URL and retains origin, CSRF and bearer protection", async () => {
  const origin = "http://203.0.113.10:3081";
  const f = await fixture({ publicUrl: origin, allowHttpIp: true });
  try {
    const response = await f.post("/api/login", { "content-type": "application/json", origin }, { username: "alice", password });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.doesNotMatch(cookie, /; Secure/);
    const data = (await response.json() as { data: { csrf: string; mcpUrl: string } }).data;
    assert.equal(data.mcpUrl, `${origin}/mcp`);
    const headers = { cookie: cookie.split(";")[0]!, "x-csrf-token": data.csrf, "content-type": "application/json", origin };
    assert.equal((await f.post("/api/token", { ...headers, "x-csrf-token": "wrong" })).status, 403);
    assert.equal((await f.post("/api/token", { ...headers, origin: "http://203.0.113.11:3081" })).status, 403);
    const tokenResponse = await f.post("/api/token", headers);
    const tokenData = (await tokenResponse.json() as { data: { token: string; mcpUrl: string } }).data;
    assert.equal(tokenData.mcpUrl, `${origin}/mcp`);
    assert.equal((await f.rpc(tokenData.token, "tools/list")).status, 200);
    assert.equal((await f.rpc("invalid", "tools/list")).status, 401);
  } finally { await f.close(); }
});

test("HTTPS IP cookies remain Secure without the HTTP opt-in", async () => {
  const f = await fixture({ publicUrl: "https://203.0.113.10" });
  try {
    const response = await f.post("/api/login", { "content-type": "application/json", origin: "https://203.0.113.10" }, { username: "alice", password });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie")!, /; Secure/);
    assert.equal((await response.json() as { data: { mcpUrl: string } }).data.mcpUrl, "https://203.0.113.10/mcp");
  } finally { await f.close(); }
});
