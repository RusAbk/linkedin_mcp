import { createApp } from "../../src/app.js";
import { errorPayload } from "../../src/errors.js";
import type { SearchFilters } from "../../src/linkedin/types.js";
import { isDeepStrictEqual } from "node:util";

const app = createApp();
const cases: Array<[string, SearchFilters]> = [
  ["school", { schools: ["Stanford University"] }],
  ["multiple-schools", { schools: ["Stanford University", "Harvard University", "Stanford University"] }],
  ["school-and-geography", { schools: ["Stanford University"], geographies: ["United States"] }],
  ["clear-schools", { geographies: ["Vietnam"] }],
  ["current-titles", { currentTitles: ["Founder", "CEO"] }],
  ["duplicate-geography", { geographies: ["Vietnam", "Vietnam"] }],
  [
    "combined-filters",
    {
      keywords: "SaaS",
      currentTitles: ["Founder"],
      geographies: ["Vietnam"],
      companyHeadcounts: ["11-50"],
      connectionDegrees: ["2nd"],
    },
  ],
];

const results: Array<Record<string, unknown>> = [];
try {
  for (const [id, filters] of cases) {
    try {
      const result = await app.service.searchPeople({ filters, limit: 5 });
      const expectedFilters = Object.fromEntries(
        Object.entries(filters).map(([key, values]) => [
          key,
          Array.isArray(values) ? [...new Set(values)] : [values],
        ]),
      );
      const pass = result.people.length > 0 && isDeepStrictEqual(result.appliedFilters, expectedFilters);
      results.push({ id, status: pass ? "PASS" : "FAIL", count: result.people.length, appliedFilters: result.appliedFilters });
    } catch (error) {
      results.push({ id, status: "FAIL", error: errorPayload(error) });
    }
  }
} finally {
  await app.close();
}

console.log(JSON.stringify(results, null, 2));
if (results.some((result) => result.status !== "PASS")) process.exit(1);
