import assert from "node:assert/strict";
import test from "node:test";
import { browserTimeout } from "../src/browser-timeout.js";

test("a stalled browser command has a bounded, actionable error", async () => {
  await assert.rejects(browserTimeout(new Promise<never>(() => {}), 20, "Chrome не отвечает"), { code: "BROWSER_ERROR", message: "Chrome не отвечает" });
  assert.equal(await browserTimeout(Promise.resolve("ready"), 20, "timeout"), "ready");
});
