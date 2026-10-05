import { z } from "zod";

export const searchFiltersSchema = z
  .object({
    keywords: z.string().trim().min(1).max(500).optional(),
    currentTitles: z.array(z.string().trim().min(1).max(150)).max(20).optional(),
    pastTitles: z.array(z.string().trim().min(1).max(150)).max(20).optional(),
    geographies: z.array(z.string().trim().min(1).max(150)).max(20).optional(),
    industries: z.array(z.string().trim().min(1).max(150)).max(20).optional(),
    currentCompanies: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    schools: z.array(z.string().trim().min(1).max(200)).max(20).optional()
      .describe("College or university names as shown in the Sales Navigator School filter; multiple names are OR alternatives."),
    companyHeadcounts: z
      .array(z.enum(["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"]))
      .max(8)
      .optional(),
    connectionDegrees: z.array(z.enum(["1st", "2nd", "3rd+"])).max(3).optional(),
  })
  .strict();

export const searchPeopleSchema = z
  .object({
    filters: searchFiltersSchema,
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().regex(/^page:[1-9]\d*(?::offset:\d+)?$/).optional(),
  })
  .strict();

export type SearchFilters = z.infer<typeof searchFiltersSchema>;
export type SearchPeopleInput = z.infer<typeof searchPeopleSchema>;

export const getProfileSchema = z
  .object({
    profileUrl: z.string().url().refine(isLinkedInProfileUrl, "profileUrl must be a LinkedIn member profile URL"),
  })
  .strict();

export const getProfilesSchema = z
  .object({
    profileUrls: z
      .array(z.string().url().refine(isLinkedInProfileUrl, "profileUrls must contain LinkedIn member profile URLs"))
      .min(1)
      .max(25),
  })
  .strict();

export const sendMessageSchema = z
  .object({
    operationId: z.string().trim().min(8).max(128),
    profileUrl: z.string().url().refine(isLinkedInUrl, "profileUrl must be a linkedin.com URL"),
    text: z.string().trim().min(1).max(3000),
    commit: z.boolean().default(false),
  })
  .strict();

export const sendConnectionSchema = z
  .object({
    operationId: z.string().trim().min(8).max(128),
    profileUrl: z.string().url().refine(isLinkedInUrl, "profileUrl must be a linkedin.com URL"),
    note: z.string().trim().max(300).optional(),
    commit: z.boolean().default(false),
  })
  .strict();

export interface PersonSummary {
  name: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  profileUrl: string;
  rawText: string;
}

export interface SearchResult {
  people: PersonSummary[];
  appliedFilters: Record<string, string[]>;
  requestedLimit: number;
  nextCursor: string | null;
  partial: boolean;
}

export interface ProfileDetails extends PersonSummary {
  about: string | null;
  experience: string[];
  visibleText: string;
  collectedAt: string;
}

export interface ProfileBatchResult {
  profiles: ProfileDetails[];
  errors: Array<{ profileUrl: string; error: Record<string, unknown> }>;
}

export function isLinkedInUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com"));
  } catch {
    return false;
  }
}

export function isLinkedInProfileUrl(value: string): boolean {
  if (!isLinkedInUrl(value)) return false;
  const pathname = new URL(value).pathname;
  return pathname.startsWith("/in/") || pathname.startsWith("/sales/lead/");
}

export function normalizeLinkedInUrl(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.toString();
}
