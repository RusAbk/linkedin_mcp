import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

test("HTTP clipboard fallback selects the personal config and clears it on logout", async () => {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  for (const clipboard of [undefined, { async writeText() { throw new Error("Permission denied"); } }]) {
    const elements = new Map<string, { value: string; hidden: boolean; textContent: string; selected: boolean; listeners: Map<string, (event: { preventDefault(): void }) => void>; [key: string]: unknown }>();
    const element = (selector: string) => {
      let item = elements.get(selector);
      if (!item) {
        item = { value: "", hidden: true, textContent: "", selected: false, listeners: new Map(), classList: { toggle() {} }, reset() {}, replaceChildren() {}, removeAttribute() {}, focus() {}, select() { this.selected = true; }, addEventListener(type: string, callback: (event: { preventDefault(): void }) => void) { this.listeners.set(type, callback); } };
        elements.set(selector, item);
      }
      return item;
    };
    const token = `ln_${"a".repeat(64)}`;
    vm.runInNewContext(source, {
      document: { querySelector: element, querySelectorAll() { return []; } },
      navigator: { clipboard },
      clearTimeout, setTimeout,
      async fetch(url: string) {
        const data = url === "/api/me" ? { csrf: "csrf", user: { username: "alice", role: "user", action_mode: "review" }, mcpUrl: "http://203.0.113.10:3081/mcp" } : url === "/api/token" ? { token } : {};
        return { ok: true, async json() { return { data }; } };
      },
    });
    const settle = () => new Promise<void>(resolve => setImmediate(resolve));
    const click = async (selector: string) => { element(selector).listeners.get("click")!({ preventDefault() {} }); await settle(); };
    await settle();
    await click("#create-token");
    await click("#copy-config");
    assert.equal(element("#manual-copy").hidden, false);
    assert.equal(element("#manual-config").selected, true);
    const config = JSON.parse(element("#manual-config").value) as { mcpServers: { linkedin: { url: string; headers: { Authorization: string } } } };
    assert.equal(config.mcpServers.linkedin.url, "http://203.0.113.10:3081/mcp");
    assert.equal(config.mcpServers.linkedin.headers.Authorization, `Bearer ${token}`);
    await click("#logout");
    assert.equal(element("#manual-copy").hidden, true);
    assert.equal(element("#manual-config").value, "");
    assert.equal(element("#mcp-token").value, "");
  }
});
