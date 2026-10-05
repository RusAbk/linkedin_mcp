import assert from "node:assert/strict";
import test from "node:test";
import {
  filterUiValue,
  formatSearchCursor,
  parseSearchCursor,
} from "../src/linkedin/sales-navigator-adapter.js";

test("search cursor preserves a position inside a result page", () => {
  assert.deepEqual(parseSearchCursor(undefined), { page: 1, offset: 0 });
  assert.deepEqual(parseSearchCursor("page:2"), { page: 2, offset: 0 });
  assert.deepEqual(parseSearchCursor("page:2:offset:7"), { page: 2, offset: 7 });
  assert.equal(formatSearchCursor(2, 0), "page:2");
  assert.equal(formatSearchCursor(2, 7), "page:2:offset:7");
  assert.throws(() => parseSearchCursor("page:0"));
});

test("API filter values map to current Sales Navigator labels", () => {
  assert.equal(filterUiValue("currentTitles", "CEO"), "Chief Executive Officer");
  assert.equal(filterUiValue("companyHeadcounts", "501-1000"), "501-1,000");
  assert.equal(filterUiValue("companyHeadcounts", "1001-5000"), "1,001-5,000");
  assert.equal(filterUiValue("companyHeadcounts", "5001-10000"), "5,001-10,000");
  assert.equal(filterUiValue("companyHeadcounts", "10001+"), "10,001+");
  assert.equal(filterUiValue("connectionDegrees", "1st"), "1st degree connections");
  assert.equal(filterUiValue("connectionDegrees", "2nd"), "2nd degree connections");
  assert.equal(filterUiValue("connectionDegrees", "3rd+"), "3rd+ degree connections");
  assert.equal(filterUiValue("geographies", "Vietnam"), "Vietnam");
});
