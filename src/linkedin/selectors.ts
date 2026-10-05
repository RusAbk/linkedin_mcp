import type { SearchFilters } from "./types.js";

export const SALES_PEOPLE_SEARCH_URL = "https://www.linkedin.com/sales/search/people";

export const filterLabels = {
  currentTitles: ["Current job title", "Current title"],
  pastTitles: ["Past job title", "Past title"],
  geographies: ["Geography", "Location"],
  industries: ["Industry"],
  currentCompanies: ["Current company"],
  schools: ["School", "Schools"],
  companyHeadcounts: ["Company headcount", "Company size"],
  connectionDegrees: ["Connection", "Connection degree"],
} as const satisfies Record<Exclude<keyof SearchFilters, "keywords">, readonly string[]>;

export const filterDataKeys = {
  currentTitles: "CURRENT_TITLE",
  pastTitles: "PAST_TITLE",
  geographies: "GEOGRAPHY",
  industries: "INDUSTRY",
  currentCompanies: "CURRENT_COMPANY",
  schools: "SCHOOL",
  companyHeadcounts: "COMPANY_HEADCOUNT",
  connectionDegrees: "RELATIONSHIP",
} as const satisfies Record<Exclude<keyof SearchFilters, "keywords">, string>;

export const resultCardSelector = [
  '.artdeco-list__item:has(a[href*="/sales/lead/"])',
  'li:has(a[href*="/sales/lead/"])',
  '[data-x-search-result]:has(a[href*="/sales/lead/"])',
  'li:has(a[href*="/in/"])',
].join(", ");

export const profileSelectors = {
  name: '[data-anonymize="person-name"]',
  title: '[data-anonymize="title"], [data-anonymize="job-title"]',
  company: '[data-anonymize="company-name"]',
  location: '[data-anonymize="location"]',
  about: '[data-anonymize="summary"]',
} as const;
