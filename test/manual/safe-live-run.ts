import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "../../src/app.js";
import { errorPayload } from "../../src/errors.js";
import type { SearchPeopleInput } from "../../src/linkedin/types.js";

type Outcome = {
  id: string;
  startedAt: string;
  finishedAt: string;
  status: "PASS" | "FAIL";
  summary: Record<string, unknown>;
};

const app = createApp();
const outcomes: Outcome[] = [];
let firstProfileUrl: string | null = null;

async function run(id: string, action: () => Promise<Record<string, unknown>>): Promise<void> {
  const startedAt = new Date().toISOString();
  process.stdout.write(`${id} START\n`);
  try {
    const summary = await action();
    outcomes.push({ id, startedAt, finishedAt: new Date().toISOString(), status: "PASS", summary });
    process.stdout.write(`${id} PASS ${JSON.stringify(summary)}\n`);
  } catch (error) {
    const summary = errorPayload(error);
    outcomes.push({ id, startedAt, finishedAt: new Date().toISOString(), status: "FAIL", summary });
    process.stdout.write(`${id} FAIL ${JSON.stringify(summary)}\n`);
  }
}

function searchSummary(result: Awaited<ReturnType<typeof app.service.searchPeople>>): Record<string, unknown> {
  if (!firstProfileUrl && result.people[0]?.profileUrl) firstProfileUrl = result.people[0].profileUrl;
  return {
    count: result.people.length,
    appliedFilters: result.appliedFilters,
    requestedLimit: result.requestedLimit,
    nextCursor: result.nextCursor,
    partial: result.partial,
    profileUrls: result.people.map((person) => person.profileUrl),
    completeness: result.people.map((person) => ({
      profileUrl: person.profileUrl,
      hasName: Boolean(person.name),
      hasTitle: Boolean(person.title),
      hasCompany: Boolean(person.company),
      hasLocation: Boolean(person.location),
      rawTextLength: person.rawText.length,
    })),
  };
}

await run("SES-02", async () => ({ ...(await app.service.sessionStatus()) }));

await run("API-08-message-preview", async () => {
  const operationId = "qa-safe-preview-message-20261001";
  const preview = await app.service.sendMessage({
    operationId,
    profileUrl: "https://www.linkedin.com/in/preview-only-test/",
    text: "QA preview only",
    commit: false,
  });
  let operationLookup = "unexpectedly-found";
  try {
    app.service.getOperation(operationId);
  } catch {
    operationLookup = "not-found";
  }
  return { preview, operationLookup };
});

await run("API-08-connection-preview", async () => {
  const operationId = "qa-safe-preview-connection-20261001";
  const preview = await app.service.sendConnection({
    operationId,
    profileUrl: "https://www.linkedin.com/in/preview-only-test/",
    note: "QA preview only",
    commit: false,
  });
  let operationLookup = "unexpectedly-found";
  try {
    app.service.getOperation(operationId);
  } catch {
    operationLookup = "not-found";
  }
  return { preview, operationLookup };
});

await run("API-09-message-disabled", async () => {
  try {
    await app.service.sendMessage({
      operationId: "qa-review-disabled-message-20261001",
      profileUrl: "https://www.linkedin.com/in/preview-only-test/",
      text: "must not send",
      commit: true,
    });
    throw new Error("Commit unexpectedly succeeded in review mode.");
  } catch (error) {
    const payload = errorPayload(error);
    const code = (payload.error as Record<string, unknown> | undefined)?.code;
    if (code !== "ACTION_DISABLED") throw error;
    return { expectedError: code };
  }
});

await run("API-09-connection-disabled", async () => {
  try {
    await app.service.sendConnection({
      operationId: "qa-review-disabled-connection-20261001",
      profileUrl: "https://www.linkedin.com/in/preview-only-test/",
      note: "must not send",
      commit: true,
    });
    throw new Error("Commit unexpectedly succeeded in review mode.");
  } catch (error) {
    const payload = errorPayload(error);
    const code = (payload.error as Record<string, unknown> | undefined)?.code;
    if (code !== "ACTION_DISABLED") throw error;
    return { expectedError: code };
  }
});

const searches: Array<[string, SearchPeopleInput]> = [
  ["FLT-01", { filters: {}, limit: 5 }],
  ["FLT-02-cyrillic", { filters: { keywords: "русский" }, limit: 5 }],
  ["FLT-03", { filters: { currentTitles: ["Founder", "CEO"] }, limit: 5 }],
  ["FLT-05", { filters: { geographies: ["Argentina"] }, limit: 5 }],
  ["FLT-06", { filters: { geographies: ["Argentina", "Vietnam"] }, limit: 5 }],
  ["FLT-07", { filters: { industries: ["Software Development"] }, limit: 5 }],
  ["FLT-08-1-10", { filters: { companyHeadcounts: ["1-10" as const] }, limit: 5 }],
  ["FLT-08-11-50", { filters: { companyHeadcounts: ["11-50" as const] }, limit: 5 }],
  ["FLT-08-51-200", { filters: { companyHeadcounts: ["51-200" as const] }, limit: 5 }],
  ["FLT-08-201-500", { filters: { companyHeadcounts: ["201-500" as const] }, limit: 5 }],
  ["FLT-08-501-1000", { filters: { companyHeadcounts: ["501-1000" as const] }, limit: 5 }],
  ["FLT-08-1001-5000", { filters: { companyHeadcounts: ["1001-5000" as const] }, limit: 5 }],
  ["FLT-08-5001-10000", { filters: { companyHeadcounts: ["5001-10000" as const] }, limit: 5 }],
  ["FLT-08-10001+", { filters: { companyHeadcounts: ["10001+" as const] }, limit: 5 }],
  ["FLT-08-multi", { filters: { companyHeadcounts: ["11-50" as const, "51-200" as const] }, limit: 5 }],
  ["FLT-09-1st", { filters: { connectionDegrees: ["1st" as const] }, limit: 5 }],
  ["FLT-09-2nd", { filters: { connectionDegrees: ["2nd" as const] }, limit: 5 }],
  ["FLT-09-3rd+", { filters: { connectionDegrees: ["3rd+" as const] }, limit: 5 }],
  ["FLT-10", { filters: { currentCompanies: ["Microsoft"] }, limit: 5 }],
  ["FLT-11", {
    filters: {
      keywords: "SaaS",
      currentTitles: ["Founder"],
      geographies: ["Vietnam"],
      companyHeadcounts: ["11-50" as const],
      connectionDegrees: ["2nd" as const],
    },
    limit: 5,
  }],
  ["FLT-12-clear", { filters: { geographies: ["Vietnam"] }, limit: 5 }],
  ["FLT-17-duplicate", { filters: { geographies: ["Vietnam", "Vietnam"] }, limit: 5 }],
];

for (const [id, input] of searches) {
  await run(id, async () => searchSummary(await app.service.searchPeople(input)));
}

await run("FLT-13", async () => {
  try {
    await app.service.searchPeople({ filters: { geographies: ["QA_NONEXISTENT_20261001"] }, limit: 5 });
    throw new Error("Unavailable filter value unexpectedly succeeded.");
  } catch (error) {
    const payload = errorPayload(error);
    const code = (payload.error as Record<string, unknown> | undefined)?.code;
    if (code !== "FILTER_UNAVAILABLE") throw error;
    return { expectedError: code, payload };
  }
});

await run("RES-06-baseline", async () =>
  searchSummary(await app.service.searchPeople({ filters: { keywords: "русский" }, limit: 10 })),
);

let cursor: string | undefined;
await run("RES-06-limit-1", async () => {
  const result = await app.service.searchPeople({ filters: { keywords: "русский" }, limit: 1 });
  cursor = result.nextCursor ?? undefined;
  return searchSummary(result);
});

await run("RES-06-cursor", async () => {
  if (!cursor) throw new Error("No cursor returned for limit=1.");
  return searchSummary(await app.service.searchPeople({ filters: { keywords: "русский" }, limit: 5, cursor }));
});

await run("RES-07", async () =>
  searchSummary(await app.service.searchPeople({ filters: { keywords: "русский" }, limit: 30 })),
);

await run("RES-09", async () => {
  const first = await app.service.searchPeople({ filters: { keywords: "русский" }, limit: 5 });
  if (!first.nextCursor) throw new Error("No cursor returned.");
  const continued = await app.service.searchPeople({ filters: { keywords: "русский" }, limit: 5, cursor: first.nextCursor });
  return { first: searchSummary(first), continued: searchSummary(continued) };
});

await run("PRF-01", async () => {
  if (!firstProfileUrl) throw new Error("Search produced no profile URL.");
  const profile = await app.service.getProfile(firstProfileUrl);
  return {
    profileUrl: profile.profileUrl,
    hasName: Boolean(profile.name),
    hasTitle: Boolean(profile.title),
    hasCompany: Boolean(profile.company),
    hasLocation: Boolean(profile.location),
    hasAbout: Boolean(profile.about),
    experienceCount: profile.experience.length,
    rawTextLength: profile.rawText.length,
    visibleTextLength: profile.visibleText.length,
    collectedAt: profile.collectedAt,
  };
});

await app.close();

const reportDir = path.resolve(".data", "test-runs");
await fs.mkdir(reportDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportPath = path.join(reportDir, `${stamp}-safe-live.json`);
await fs.writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), outcomes }, null, 2), "utf8");
process.stdout.write(`REPORT ${reportPath}\n`);
process.stdout.write(`SUMMARY ${JSON.stringify({ total: outcomes.length, pass: outcomes.filter((x) => x.status === "PASS").length, fail: outcomes.filter((x) => x.status === "FAIL").length })}\n`);
