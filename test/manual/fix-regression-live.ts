import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "../../src/app.js";
import { errorPayload } from "../../src/errors.js";
import type { SearchFilters } from "../../src/linkedin/types.js";

type Result = { id: string; status: "PASS" | "FAIL"; detail: unknown };
const app = createApp();
const results: Result[] = [];

async function check(id: string, action: () => Promise<unknown>): Promise<unknown> {
  process.stdout.write(`${id} START\n`);
  try {
    const detail = await action();
    results.push({ id, status: "PASS", detail });
    process.stdout.write(`${id} PASS ${JSON.stringify(detail)}\n`);
    return detail;
  } catch (error) {
    const detail = errorPayload(error);
    results.push({ id, status: "FAIL", detail });
    process.stdout.write(`${id} FAIL ${JSON.stringify(detail)}\n`);
    return null;
  }
}

await check("BUG-02-session-from-feed", async () => {
  await app.browser.runExclusive(async (page) => {
    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  });
  const status = await app.service.sessionStatus();
  if (status.state !== "authenticated" || !status.salesNavigatorAvailable) {
    throw new Error(`Unexpected session status: ${JSON.stringify(status)}`);
  }
  return status;
});

await check("BUG-01-empty-search", async () => {
  try {
    await app.service.searchPeople({ filters: {}, limit: 5 });
    throw new Error("Empty search unexpectedly succeeded.");
  } catch (error) {
    const payload = errorPayload(error);
    const code = (payload.error as Record<string, unknown> | undefined)?.code;
    if (code !== "INVALID_INPUT") throw error;
    return { expectedError: code };
  }
});

const filterCases: Array<[string, SearchFilters]> = [
  ["BUG-03-current-titles", { currentTitles: ["Founder", "CEO"] }],
  ["BUG-10-past-title", { pastTitles: ["Founder"] }],
  ["BUG-04-headcount-501-1000", { companyHeadcounts: ["501-1000" as const] }],
  ["BUG-04-headcount-1001-5000", { companyHeadcounts: ["1001-5000" as const] }],
  ["BUG-04-headcount-5001-10000", { companyHeadcounts: ["5001-10000" as const] }],
  ["BUG-04-headcount-10001+", { companyHeadcounts: ["10001+" as const] }],
  ["BUG-05-connection-1st", { connectionDegrees: ["1st" as const] }],
  ["BUG-05-connection-2nd", { connectionDegrees: ["2nd" as const] }],
  ["BUG-05-connection-3rd+", { connectionDegrees: ["3rd+" as const] }],
  ["BUG-07-duplicate-geography", { geographies: ["Vietnam", "Vietnam"] }],
];

for (const [id, filters] of filterCases) {
  await check(id, async () => {
    const result = await app.service.searchPeople({ filters, limit: 5 });
    if (result.people.length !== 5) throw new Error(`Expected 5 people, got ${result.people.length}.`);
    return { count: result.people.length, appliedFilters: result.appliedFilters, nextCursor: result.nextCursor };
  });
}

await check("BUG-06-combined-filters", async () => {
  const result = await app.service.searchPeople({
    filters: {
      keywords: "SaaS",
      currentTitles: ["Founder"],
      geographies: ["Vietnam"],
      companyHeadcounts: ["11-50"],
      connectionDegrees: ["2nd"],
    },
    limit: 5,
  });
  return { count: result.people.length, appliedFilters: result.appliedFilters, nextCursor: result.nextCursor };
});

let firstProfileUrl: string | null = null;
await check("BUG-08-cursor-offset", async () => {
  const first = await app.service.searchPeople({ filters: { keywords: "русский" }, limit: 1 });
  firstProfileUrl = first.people[0]?.profileUrl ?? null;
  if (!first.nextCursor?.includes(":offset:")) throw new Error(`Expected offset cursor, got ${first.nextCursor}.`);
  const continued = await app.service.searchPeople({
    filters: { keywords: "русский" },
    limit: 5,
    cursor: first.nextCursor,
  });
  if (continued.people.length !== 5) throw new Error(`Expected 5 continued results, got ${continued.people.length}.`);
  if (continued.people.some((person) => person.profileUrl === first.people[0]?.profileUrl)) {
    throw new Error("Continuation repeated the previously returned profile.");
  }
  return {
    firstCount: first.people.length,
    firstCursor: first.nextCursor,
    continuedCount: continued.people.length,
    continuedCursor: continued.nextCursor,
  };
});

await check("BUG-09-profile-timeout", async () => {
  if (!firstProfileUrl) throw new Error("No profile URL was produced by the cursor test.");
  const startedAt = Date.now();
  const profile = await app.service.getProfile(firstProfileUrl);
  const durationMs = Date.now() - startedAt;
  if (!profile.name) throw new Error("Profile has no name.");
  if (durationMs > 60_000) throw new Error(`Profile read took ${durationMs} ms.`);
  return {
    durationMs,
    hasName: Boolean(profile.name),
    hasTitle: Boolean(profile.title),
    hasCompany: Boolean(profile.company),
    experienceCount: profile.experience.length,
  };
});

await app.close();
const reportDir = path.resolve(".data", "test-runs");
await fs.mkdir(reportDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportPath = path.join(reportDir, `${stamp}-fix-regression-live.json`);
await fs.writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2), "utf8");
process.stdout.write(`REPORT ${reportPath}\n`);
process.stdout.write(
  `SUMMARY ${JSON.stringify({ total: results.length, pass: results.filter((item) => item.status === "PASS").length, fail: results.filter((item) => item.status === "FAIL").length })}\n`,
);
