import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
type UiEvent = { preventDefault(): void; clientX: number; clientY: number };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const image = (version: number) => ({ image: `jpeg-${version}`, version, width: 1440, height: 1000, url: "https://www.linkedin.com/login", complete: false });

function ui(request: (url: string, options: { body?: string }) => Promise<unknown>, live = true) {
  class Element {
    value = ""; hidden = true; textContent = ""; src = ""; focused = false; disabled = false;
    listeners = new Map<string, (event: UiEvent) => void>();
    elements = { text: { value: "", focused: false, focus() { this.focused = true; } } };
    classList = { toggle() {} };
    addEventListener(type: string, callback: (event: UiEvent) => void) { this.listeners.set(type, callback); }
    reset() {} replaceChildren() {} scrollIntoView() {}
    removeAttribute() { this.src = ""; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 720, height: 500 }; }
  }
  class Stream {
    static instances: Stream[] = [];
    listeners = new Map<string, (event: { data: string }) => void>();
    closed = false; onerror: (() => void) | undefined;
    constructor(readonly url: string) { Stream.instances.push(this); }
    addEventListener(type: string, callback: (event: { data: string }) => void) { this.listeners.set(type, callback); }
    emit(type: string, data: unknown) { this.listeners.get(type)!({ data: JSON.stringify(data) }); }
    close() { this.closed = true; }
  }
  const nodes = new Map<string, Element>(), timers = new Map<number, () => void>();
  const element = (selector: string) => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector)!; };
  const document = { hidden: false, querySelector: element, querySelectorAll() { return []; }, addEventListener() {} };
  let timerId = 0;
  vm.runInNewContext(source, {
    document, navigator: {}, AbortController,
    ...(live ? { EventSource: Stream } : {}),
    setTimeout(callback: () => void) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
    async fetch(url: string, options: { body?: string }) {
      const data = url === "/api/me" ? { user: { username: "alice", role: "user", action_mode: "review" }, csrf: "csrf", mcpUrl: "http://localhost/mcp" } : await request(url, options);
      return { ok: true, async json() { return { data }; } };
    },
  });
  const event = async (selector: string, type = "click") => { element(selector).listeners.get(type)!({ preventDefault() {}, clientX: 360, clientY: 250 }); await settle(); };
  return { element, event, streams: Stream.instances, timers };
}

test("live frames and focus update while a click is pending; hiding cancels queued input", async () => {
  const gate = deferred<unknown>(), inputs: unknown[] = [];
  const app = ui(async (url, options) => {
    assert.notEqual(url, "/api/linkedin/frame");
    if (url === "/api/linkedin/input") { inputs.push(JSON.parse(options.body!)); return gate.promise; }
    return {};
  });
  await settle(); await app.event("#open-linkedin");
  const stream = app.streams[0]!; assert.equal(stream.url, "/api/linkedin/stream");
  stream.emit("frame", image(1)); await settle();
  await app.event("#browser-image");
  assert.equal(app.element("#browser-text-form").elements.text.focused, true);
  assert.deepEqual(inputs, [{ type: "click", x: 720, y: 500 }]);
  app.element("#browser-text-form").elements.text.value = "private-input";
  await app.event("#browser-text-form", "submit");
  assert.equal(inputs.length, 1);
  stream.emit("frame", image(2)); await settle();
  assert.equal(app.element("#browser-image").src, "data:image/jpeg;base64,jpeg-2");
  await app.event("#hide-browser"); assert.equal(stream.closed, true);
  gate.resolve({}); await settle(); await settle();
  assert.equal(inputs.length, 1);
  stream.emit("frame", image(3)); await settle();
  assert.equal(app.element("#browser-image").src, "");
});

test("fallback refresh never blocks input and late frames cannot reopen a hidden window", async () => {
  const gate = deferred<unknown>(); let reads = 0, inputs = 0;
  const app = ui(async url => {
    if (url === "/api/linkedin/frame") return ++reads === 1 ? image(1) : gate.promise;
    if (url === "/api/linkedin/input") inputs++;
    return {};
  }, false);
  await settle(); await app.event("#open-linkedin");
  assert.equal(reads, 1);
  const [id, callback] = [...app.timers][0]!; app.timers.delete(id); callback(); await settle();
  assert.equal(reads, 2);
  await app.event("#browser-image"); assert.equal(inputs, 1);
  await app.event("#hide-browser"); gate.resolve(image(2)); await settle();
  assert.equal(app.element("#browser-image").src, "");
  assert.equal(app.element("#browser-panel").hidden, true);
  assert.equal(app.timers.size, 0);
});
