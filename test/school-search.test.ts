import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test, { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import type { BrowserManager } from "../src/browser/browser-manager.js";
import { ConnectorError } from "../src/errors.js";
import { SalesNavigatorAdapter } from "../src/linkedin/sales-navigator-adapter.js";

let browser: Browser;
before(async () => { browser = await chromium.launch({ channel: "chrome", headless: true }); });
after(async () => { await browser?.close(); });

async function fixture() {
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  const html = await fs.readFile(new URL("./fixtures/school-search.html", import.meta.url), "utf8");
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: html }));
  let diagnostics = 0;
  const manager = {
    runExclusiveOn: (_role: string, task: (page: Page) => Promise<unknown>) => task(page),
    assertAuthenticated: async () => undefined,
    saveDiagnostics: async () => { diagnostics += 1; return { screenshot: null, html: null }; },
  } as unknown as BrowserManager;
  return { page, adapter: new SalesNavigatorAdapter(manager), diagnostics: () => diagnostics };
}

test("school-only search opens all filters, selects the exact school and supports continuation", async () => {
  const { page, adapter } = await fixture();
  try {
    const filters = { schools: ["Stanford University"] };
    const result = await adapter.searchPeople(filters, 1);
    assert.deepEqual(result.appliedFilters, filters);
    assert.deepEqual(result.people.map(person => person.name), ["stanford-vietnam"]);
    assert.equal(result.nextCursor, "page:1:offset:1");
    const next = await adapter.searchPeople(filters, 1, result.nextCursor!);
    assert.deepEqual(next.people.map(person => person.name), ["stanford-usa"]);
    assert.equal(next.nextCursor, null);
    assert.deepEqual(await page.evaluate("window.filterClicks"), [{ key: "SCHOOL", value: "Stanford University" }]);
    const changed = await adapter.searchPeople({ schools: ["Harvard University"] }, 5);
    assert.deepEqual(changed.people.map(person => person.name), ["harvard-vietnam"]);
  } finally { await page.close(); }
});

test("multiple schools deduplicate, combine with geography, and clear on a later search", async () => {
  const { page, adapter } = await fixture();
  try {
    const result = await adapter.searchPeople({ schools: ["Stanford University", "Harvard University", "Stanford University"], geographies: ["Vietnam"] }, 5);
    assert.deepEqual(result.appliedFilters, { geographies: ["Vietnam"], schools: ["Stanford University", "Harvard University"] });
    assert.deepEqual(result.people.map(person => person.name), ["stanford-vietnam", "harvard-vietnam"]);
    const cleared = await adapter.searchPeople({ geographies: ["Vietnam"] }, 5);
    assert.deepEqual(cleared.appliedFilters, { geographies: ["Vietnam"] });
    assert.equal(cleared.people.length, 3);
    assert.equal(await page.getByLabel(/^Remove School filter:/).count(), 0);
  } finally { await page.close(); }
});

test("a longer school name is never selected as a substitute for an unavailable exact match", async () => {
  const { page, adapter, diagnostics } = await fixture();
  try {
    await page.goto("https://www.linkedin.com/sales/search/people");
    await page.evaluate("window.schoolChoices = ['Stanford University School of Medicine']");
    await assert.rejects(adapter.searchPeople({ schools: ["Stanford University"] }, 5), (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "FILTER_UNAVAILABLE");
      return true;
    });
    assert.deepEqual(await page.evaluate("window.filterClicks"), []);
    assert.equal(diagnostics(), 1);
  } finally { await page.close(); }
});

test("school is not reported as applied if the UI drops the selection", async () => {
  const { page, adapter, diagnostics } = await fixture();
  try {
    await page.goto("https://www.linkedin.com/sales/search/people");
    await page.evaluate("window.retainSelection = false");
    await assert.rejects(adapter.searchPeople({ schools: ["Stanford University"] }, 5), (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "FILTER_UNAVAILABLE");
      assert.match(error.message, /did not remain selected/);
      return true;
    });
    assert.equal(diagnostics(), 1);
  } finally { await page.close(); }
});

test("school names with accents and parentheses are matched literally", async () => {
  const { page, adapter } = await fixture();
  try {
    await page.goto("https://www.linkedin.com/sales/search/people");
    await page.evaluate("window.schoolChoices = ['École Polytechnique (Paris)']");
    const result = await adapter.searchPeople({ schools: ["École Polytechnique (Paris)"] }, 5);
    assert.deepEqual(result.people.map(person => person.name), ["polytechnique-france"]);
  } finally { await page.close(); }
});
