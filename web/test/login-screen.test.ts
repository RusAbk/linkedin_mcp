import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { chromium, type Page } from "playwright";
import { LoginScreen } from "../src/login-screen.js";

test("screen retains the latest frame and acknowledges only when the viewer reads", async () => {
  const session = new EventEmitter() as EventEmitter & { send: (method: string, args?: unknown) => Promise<unknown>; detach: () => Promise<void> };
  const calls: { method: string; args?: unknown }[] = [];
  session.send = async (method, args) => { calls.push({ method, args }); return { data: "initial" }; };
  session.detach = async () => { calls.push({ method: "detach" }); };
  const screen = new LoginScreen({ async bringToFront() {}, context: () => ({ newCDPSession: async () => session }) } as unknown as Page);
  await screen.start();
  session.emit("Page.screencastFrame", { data: "old", sessionId: 1 });
  session.emit("Page.screencastFrame", { data: "new", sessionId: 2 });
  assert.equal(calls.filter(call => call.method === "Page.screencastFrameAck").length, 0);
  assert.equal(screen.read().image, "new");
  assert.equal(calls.filter(call => call.method === "Page.screencastFrameAck").length, 2);
  screen.read();
  assert.equal(calls.filter(call => call.method === "Page.screencastFrameAck").length, 2);
  await screen.close();
  session.emit("Page.screencastFrame", { data: "late", sessionId: 3 });
  assert.equal(screen.read().image, undefined);
  assert.ok(calls.some(call => call.method === "Page.stopScreencast"));
  assert.ok(calls.some(call => call.method === "detach"));
});

test("real Chrome updates frames after input without waiting for web fonts", { skip: process.env.WEB_BROWSER_TESTS !== "1", timeout: 20_000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const screen = new LoginScreen(page);
  let releaseFont!: () => void;
  const fontGate = new Promise<void>(resolve => { releaseFont = resolve; });
  let oldCapture: Promise<Buffer> | undefined;
  try {
    await page.route("https://fonts.test/slow.woff2", async route => { await fontGate; await route.abort(); });
    await page.setContent('<style>@font-face{font-family:Slow;src:url(https://fonts.test/slow.woff2)}body{font-family:Slow,Arial}button{font:30px Arial;background:green;color:white}</style><p>Pending web font</p><button onclick="this.style.background=\'red\';this.textContent=\'Clicked\'">Click</button>', { waitUntil: "domcontentloaded" });
    await page.evaluate(() => { void document.fonts.load("16px Slow").catch(() => {}); });
    await page.waitForFunction(() => document.fonts.status === "loading");
    let oldFinished = false;
    oldCapture = page.screenshot({ type: "jpeg", quality: 75 }).then(image => { oldFinished = true; return image; });
    const started = performance.now();
    await screen.start();
    const first = screen.read();
    assert.ok(first.image);
    assert.equal(oldFinished, false);
    assert.equal(await page.evaluate(() => document.fonts.status), "loading");
    console.log(`Native first frame: ${Math.round(performance.now() - started)}ms while the previous capture is waiting for fonts`);
    await page.getByRole("button").click();
    assert.equal(await page.getByRole("button").textContent(), "Clicked");
    let updated = screen.read();
    for (let attempt = 0; attempt < 20 && (updated.version <= first.version || updated.image === first.image); attempt++) {
      await delay(50); updated = screen.read();
    }
    assert.ok(updated.version > first.version);
    assert.notEqual(updated.image, first.image);
  } finally {
    releaseFont();
    await oldCapture?.catch(() => {});
    await screen.close(); await browser.close();
  }
});
