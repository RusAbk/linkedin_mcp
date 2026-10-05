import assert from "node:assert/strict";
import test from "node:test";
import { getProfileSchema, getProfilesSchema, searchPeopleSchema, sendMessageSchema } from "../src/linkedin/types.js";

test("search schema applies a conservative default result limit", () => {
  const parsed = searchPeopleSchema.parse({ filters: { currentTitles: ["Founder"] } });
  assert.equal(parsed.limit, 25);
});

test("school search accepts multiple trimmed names and validates limits", () => {
  assert.deepEqual(
    searchPeopleSchema.parse({ filters: { schools: [" Stanford University ", "Harvard University"] } }).filters.schools,
    ["Stanford University", "Harvard University"],
  );
  for (const schools of [[" "], ["x".repeat(201)], Array(21).fill("Stanford University"), "Stanford University"]) {
    assert.throws(() => searchPeopleSchema.parse({ filters: { schools } }));
  }
  assert.throws(() => searchPeopleSchema.parse({ filters: { school: "Stanford University" } }));
});

test("mutating tool defaults to preview", () => {
  const parsed = sendMessageSchema.parse({
    operationId: "message-123",
    profileUrl: "https://www.linkedin.com/in/example/",
    text: "Hello",
  });
  assert.equal(parsed.commit, false);
});

test("search cursor accepts a page offset and rejects page zero", () => {
  assert.equal(
    searchPeopleSchema.parse({ filters: { keywords: "SaaS" }, cursor: "page:1:offset:5" }).cursor,
    "page:1:offset:5",
  );
  assert.throws(() => searchPeopleSchema.parse({ filters: { keywords: "SaaS" }, cursor: "page:0" }));
});

test("profile schema rejects non-member LinkedIn pages", () => {
  assert.equal(
    getProfileSchema.parse({ profileUrl: "https://www.linkedin.com/in/example/" }).profileUrl,
    "https://www.linkedin.com/in/example/",
  );
  assert.throws(() => getProfileSchema.parse({ profileUrl: "https://www.linkedin.com/company/example/" }));
});

test("profile batch accepts at most 25 member profiles", () => {
  const profileUrls = Array.from({ length: 25 }, (_, index) => `https://www.linkedin.com/in/example-${index}/`);
  assert.equal(getProfilesSchema.parse({ profileUrls }).profileUrls.length, 25);
  assert.throws(() => getProfilesSchema.parse({ profileUrls: [...profileUrls, profileUrls[0]] }));
});
