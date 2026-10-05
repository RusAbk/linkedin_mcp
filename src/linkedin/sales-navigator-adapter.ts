import type { Locator, Page } from "playwright";
import type { BrowserManager } from "../browser/browser-manager.js";
import { ActionOutcomeUnknownError, ConnectorError } from "../errors.js";
import {
  filterDataKeys,
  filterLabels,
  profileSelectors,
  resultCardSelector,
  SALES_PEOPLE_SEARCH_URL,
} from "./selectors.js";
import {
  normalizeLinkedInUrl,
  type PersonSummary,
  type ProfileDetails,
  type SearchFilters,
  type SearchResult,
} from "./types.js";

export type FilterKey = Exclude<keyof SearchFilters, "keywords">;

export class SalesNavigatorAdapter {
  private searchState: {
    signature: string;
    page: number;
    appliedFilters: Record<string, string[]>;
  } | null = null;

  constructor(private readonly browser: BrowserManager) {}

  async searchPeople(filters: SearchFilters, limit: number, cursor?: string): Promise<SearchResult> {
    return this.browser.runExclusiveOn("search", async (page) => {
      try {
        if (!hasSearchCriteria(filters)) {
          throw new ConnectorError(
            "INVALID_INPUT",
            "Sales Navigator requires at least one search criterion in the current interface.",
          );
        }
        const { page: startPage, offset: startOffset } = parseSearchCursor(cursor);
        const signature = searchSignature(filters);
        const canReuse =
          this.searchState?.signature === signature &&
          this.searchState.page <= startPage &&
          page.url().includes("/sales/search/people");

        let appliedFilters: Record<string, string[]>;
        let currentPage: number;
        if (canReuse && this.searchState) {
          appliedFilters = this.searchState.appliedFilters;
          currentPage = this.searchState.page;
          await this.browser.assertAuthenticated(page);
        } else {
          if (!page.url().includes("/sales/search/people")) {
            await page.goto(SALES_PEOPLE_SEARCH_URL, { waitUntil: "domcontentloaded" });
          }
          await this.browser.assertAuthenticated(page);
          if (!page.url().includes("/sales/")) {
            throw new ConnectorError(
              "AUTH_REQUIRED",
              "Sales Navigator is not available for the current LinkedIn session.",
              { url: page.url() },
            );
          }
          await this.resetFilters(page);
          appliedFilters = await this.applyFilters(page, filters);
          await this.extractPeople(page);
          currentPage = 1;
          this.searchState = { signature, page: currentPage, appliedFilters };
        }

        for (let pageNumber = currentPage; pageNumber < startPage; pageNumber += 1) {
          if (!(await this.goToNextPage(page))) {
            return { people: [], appliedFilters, requestedLimit: limit, nextCursor: null, partial: true };
          }
          currentPage += 1;
          if (this.searchState) this.searchState.page = currentPage;
        }

        const people: PersonSummary[] = [];
        let offset = startOffset;
        let nextCursor: string | null = null;
        let partial = false;
        while (people.length < limit) {
          const pagePeople = await this.extractPeople(page);
          let index = Math.min(offset, pagePeople.length);
          for (; index < pagePeople.length; index += 1) {
            const person = pagePeople[index];
            if (!person) continue;
            if (!people.some((existing) => existing.profileUrl === person.profileUrl)) people.push(person);
            if (people.length >= limit) {
              index += 1;
              break;
            }
          }

          if (people.length >= limit) {
            if (index < pagePeople.length) {
              nextCursor = formatSearchCursor(currentPage, index);
            } else if (await this.hasNextPage(page)) {
              nextCursor = formatSearchCursor(currentPage + 1, 0);
            }
            break;
          }

          const hasMore = await this.hasNextPage(page);
          if (!hasMore) break;
          const moved = await this.goToNextPage(page);
          if (!moved) {
            partial = true;
            break;
          }
          currentPage += 1;
          if (this.searchState) this.searchState.page = currentPage;
          offset = 0;
        }

        return {
          people: people.slice(0, limit),
          appliedFilters,
          requestedLimit: limit,
          nextCursor,
          partial,
        };
      } catch (error) {
        this.searchState = null;
        if (error instanceof ConnectorError) throw error;
        const diagnostics = await this.browser.saveDiagnostics(page, "search-failed");
        throw new ConnectorError("UI_CHANGED", "The Sales Navigator search workflow could not match the current UI.", {
          cause: error instanceof Error ? error.message : String(error),
          diagnostics,
        });
      }
    });
  }

  async getProfile(profileUrl: string): Promise<ProfileDetails> {
    return this.browser.runExclusiveOn("profile", async (page) => {
      await page.goto(normalizeLinkedInUrl(profileUrl), { waitUntil: "domcontentloaded" });
      await this.browser.assertAuthenticated(page);
      const main = page.locator("main, [role=main]").first();
      await main.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);

      const name = await firstText(main.locator(profileSelectors.name));
      const title = await firstText(main.locator(profileSelectors.title));
      const company = await firstText(main.locator(profileSelectors.company));
      const location = await firstText(main.locator(profileSelectors.location));
      const about =
        (await firstText(main.locator(profileSelectors.about))) ??
        (await sectionText(main, /^(about|summary)$/i, 4_000));
      const visibleText = cleanText(
        (await main.innerText({ timeout: 5_000 }).catch(() => "")).slice(0, 16_000),
      );
      const experience = await sectionLines(main, /experience/i, 40);

      if (!name) {
        const diagnostics = await this.browser.saveDiagnostics(page, "profile-empty");
        throw new ConnectorError("UI_CHANGED", "Profile data was not found in the current page layout.", {
          url: page.url(),
          diagnostics,
        });
      }

      return {
        name,
        title,
        company,
        location,
        profileUrl: normalizeLinkedInUrl(page.url()),
        rawText: visibleText.slice(0, 2_000),
        about,
        experience,
        visibleText,
        collectedAt: new Date().toISOString(),
      };
    });
  }

  async messageAlreadySent(profileUrl: string, text: string): Promise<boolean> {
    return this.browser.runExclusiveOn("profile", async (page) => {
      await this.openProfile(page, profileUrl);
      const dialog = await this.openMessageComposer(page);
      const found = await outgoingMessageVisible(page, dialog, text);
      await page.keyboard.press("Escape").catch(() => undefined);
      return found;
    });
  }

  async sendMessage(profileUrl: string, text: string): Promise<Record<string, unknown>> {
    return this.browser.runExclusiveOn("profile", async (page) => {
      await this.openProfile(page, profileUrl);
      const dialog = await this.openMessageComposer(page);
      const input = await firstVisible([
        dialog.getByRole("textbox", { name: /message/i }),
        dialog.locator("textarea"),
        dialog.locator('[contenteditable="true"]'),
      ]);
      if (!input) throw new ConnectorError("UI_CHANGED", "Message input was not found.");
      await input.fill(text);
      const sendButton = await firstVisible([
        dialog.getByRole("button", { name: /^send$/i }),
        dialog.locator('button[type="submit"]'),
      ]);
      if (!sendButton) throw new ConnectorError("UI_CHANGED", "Send button was not found.");

      await sendButton.click();
      const verified = await waitUntil(() => outgoingMessageVisible(page, dialog, text), 7_000);
      if (!verified) {
        const diagnostics = await this.browser.saveDiagnostics(page, "message-outcome-unknown");
        throw new ActionOutcomeUnknownError("The send button was clicked, but the result could not be verified.", {
          profileUrl,
          diagnostics,
        });
      }
      return { sent: true, profileUrl: normalizeLinkedInUrl(profileUrl), verifiedAt: new Date().toISOString() };
    });
  }

  async connectionState(profileUrl: string): Promise<"pending" | "connected" | "available"> {
    return this.browser.runExclusiveOn("profile", async (page) => {
      await this.openProfile(page, profileUrl);
      const main = page.locator("main, [role=main]").first();
      if (await anyVisible(main.getByRole("button", { name: /pending/i }))) return "pending";
      if (await this.findConnectButton(main)) return "available";
      const moreButton = await firstVisible([
        main.getByRole("button", { name: /^more/i }),
        main.getByRole("button", { name: /more actions/i }),
      ]);
      if (moreButton) {
        await moreButton.click();
        const menuConnect = await firstVisible([page.getByRole("menuitem", { name: /^connect/i })]);
        await page.keyboard.press("Escape").catch(() => undefined);
        if (menuConnect) return "available";
      }
      if (await anyVisible(main.getByText(/1st degree connection|·\s*1st\b/i))) return "connected";
      return "available";
    });
  }

  async sendConnection(profileUrl: string, note?: string): Promise<Record<string, unknown>> {
    return this.browser.runExclusiveOn("profile", async (page) => {
      await this.openProfile(page, profileUrl);
      const main = page.locator("main, [role=main]").first();
      if (await anyVisible(main.getByRole("button", { name: /pending/i }))) {
        return { sent: false, alreadyPending: true, profileUrl: normalizeLinkedInUrl(profileUrl) };
      }

      let connectButton = await this.findConnectButton(main);
      if (!connectButton) {
        const moreButton = await firstVisible([
          main.getByRole("button", { name: /^more/i }),
          main.getByRole("button", { name: /more actions/i }),
        ]);
        if (moreButton) {
          await moreButton.click();
          connectButton = await firstVisible([
            page.getByRole("menuitem", { name: /^connect/i }),
            page.getByText(/^connect$/i, { exact: true }),
          ]);
        }
      }
      if (!connectButton) {
        throw new ConnectorError("NOT_FOUND", "A Connect action is not available for this profile.", { profileUrl });
      }
      await connectButton.click();
      const dialog = await visibleDialog(page);
      if (!dialog) throw new ConnectorError("UI_CHANGED", "Connection dialog did not open.");

      if (note) {
        const addNote = await firstVisible([dialog.getByRole("button", { name: /add a note/i })]);
        if (addNote) await addNote.click();
        const noteInput = await firstVisible([
          dialog.getByRole("textbox", { name: /note|message/i }),
          dialog.locator("textarea"),
        ]);
        if (!noteInput) throw new ConnectorError("UI_CHANGED", "Connection note input was not found.");
        await noteInput.fill(note);
      }

      const sendButton = await firstVisible([
        dialog.getByRole("button", { name: /send( invitation)?|connect/i }),
        dialog.locator('button[type="submit"]'),
      ]);
      if (!sendButton) throw new ConnectorError("UI_CHANGED", "Send invitation button was not found.");
      await sendButton.click();
      const verified = await waitUntil(
        () => anyVisible(main.getByRole("button", { name: /pending/i })),
        7_000,
      );
      if (!verified) {
        const diagnostics = await this.browser.saveDiagnostics(page, "connection-outcome-unknown");
        throw new ActionOutcomeUnknownError("The invitation button was clicked, but the result could not be verified.", {
          profileUrl,
          diagnostics,
        });
      }
      return { sent: true, profileUrl: normalizeLinkedInUrl(profileUrl), verifiedAt: new Date().toISOString() };
    });
  }

  async inspectCurrentPage(): Promise<Record<string, unknown>> {
    return this.browser.runExclusive(async (page) => {
      const diagnostics = await this.browser.saveDiagnostics(page, "manual-inspect");
      const inputs = await page.locator("input").evaluateAll((nodes) =>
        nodes.map((node) => {
          const input = node as HTMLInputElement;
          return {
            type: input.type,
            name: input.name,
            placeholder: input.placeholder,
            ariaLabel: input.getAttribute("aria-label"),
          };
        }),
      );
      const bodyText = cleanText(await page.locator("body").innerText().catch(() => "")).slice(0, 2_000);
      return {
        url: page.url(),
        title: await page.title(),
        bodyText,
        inputs,
        frames: page.frames().map((frame) => frame.url()),
        diagnostics,
      };
    });
  }

  private async openProfile(page: Page, profileUrl: string): Promise<void> {
    await page.goto(normalizeLinkedInUrl(profileUrl), { waitUntil: "domcontentloaded" });
    await this.browser.assertAuthenticated(page);
  }

  private async resetFilters(page: Page): Promise<void> {
    const reset = await firstVisible([
      page.getByRole("button", { name: /clear all filter values/i }),
      page.getByRole("button", { name: /reset filters/i }),
      page.getByRole("link", { name: /reset filters/i }),
      page.getByText(/reset filters/i, { exact: true }),
    ]);
    if (reset && (await reset.isEnabled().catch(() => false))) {
      await reset.click();
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    }
    const clearKeywords = await firstVisible([page.getByRole("button", { name: /clear the search/i })]);
    if (clearKeywords && (await clearKeywords.isEnabled().catch(() => false))) {
      await clearKeywords.click().catch(() => undefined);
    } else {
      const keywordInput = await firstVisible([page.locator('input[placeholder*="keyword" i]')]);
      if (keywordInput && (await keywordInput.inputValue().catch(() => ""))) await keywordInput.fill("");
    }
  }

  private async applyFilters(page: Page, filters: SearchFilters): Promise<Record<string, string[]>> {
    const applied: Record<string, string[]> = {};
    const dismissButtons = page.getByRole("button", { name: /^dismiss$/i });
    for (let index = (await dismissButtons.count()) - 1; index >= 0; index -= 1) {
      const dismiss = dismissButtons.nth(index);
      if (await dismiss.isVisible().catch(() => false)) await dismiss.click().catch(() => undefined);
    }
    if (filters.keywords) {
      const input = await firstVisible([
        page.getByRole("textbox", { name: /keywords/i }),
        page.locator('input[placeholder*="keyword" i]'),
      ]);
      if (!input) throw new ConnectorError("FILTER_UNAVAILABLE", "The Keywords input was not found.");
      await input.fill(filters.keywords);
      await input.press("Enter");
      applied.keywords = [filters.keywords];
    }

    for (const key of Object.keys(filterLabels) as FilterKey[]) {
      const values = [...new Set(filters[key])];
      if (!values?.length) continue;
      await this.applyMultiValueFilter(page, key, values);
      applied[key] = [...values];
    }

    const apply = await firstVisible([page.getByRole("button", { name: /^apply( filters)?$/i })]);
    if (apply) await apply.click();
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    return applied;
  }

  private async applyMultiValueFilter(page: Page, key: FilterKey, values: readonly string[]): Promise<void> {
    const labels = filterLabels[key];
    const dataKey = filterDataKeys[key];
    const panel = page.locator(`fieldset[data-x-search-filter="${dataKey}"]`).first();
    let trigger = await this.findFilterTrigger(page, panel, labels);
    if (!trigger) {
      const seeAll = await firstVisible([
        page.getByRole("button", { name: /see all filters/i }),
        page.getByText(/see all filters/i, { exact: true }),
      ]);
      if (seeAll) {
        await seeAll.click();
        await page.waitForTimeout(300);
        trigger = await this.findFilterTrigger(page, panel, labels);
      }
    }
    if (!trigger) {
      throw new ConnectorError("FILTER_UNAVAILABLE", `Filter '${labels[0]}' was not found.`, { key });
    }
    await trigger.click();
    await waitForFilterPanelReady(panel, 1_500);

    for (const value of values) {
      const displayValue = filterUiValue(key, value);
      await waitForFilterPanelReady(panel, 500);
      let input = await findVisibleFilterInput(panel);
      if (!input && !(await hasVisibleFilterChoices(panel))) {
        const currentTrigger = await this.findFilterTrigger(page, panel, labels);
        if (currentTrigger) {
          await currentTrigger.click();
          await waitForFilterPanelReady(panel, 1_500);
          input = await findVisibleFilterInput(panel);
        }
      }
      if (input) {
        await typeIntoDynamicFilter(panel, input, value);
        await page.waitForTimeout(400);
      }
      // Suggestions may contain result counts, but a longer school/company name
      // must never be accepted as a match for the requested institution.
      const exact = new RegExp(`^${escapeRegex(displayValue)}(?:\\s*\\([\\d.,KMB+\\s]+\\))?$`, "i");
      const optionName = new RegExp(`^(?:Add\\s+)?${escapeRegex(displayValue)}(?:\\s*\\([\\d.,KMB+\\s]+\\))?$`, "i");
      const uiFilterLabel = key === "geographies" ? "Region" : labels[0];
      const includeOptionName = new RegExp(
        `^Include\\s+[\"“”]?${escapeRegex(displayValue)}[\"“”]?\\s+in\\s+${escapeRegex(uiFilterLabel)}`,
        "i",
      );
      const option = await waitForFirstVisible([
        panel.getByRole("option", { name: includeOptionName }),
        panel.getByRole("button", { name: includeOptionName }),
        panel.getByRole("option", { name: exact }),
        panel.getByRole("checkbox", { name: exact }),
        panel.getByText(exact, { exact: true }),
        panel.getByRole("button", { name: optionName }),
        page.getByRole("option", { name: includeOptionName }),
      ], 6_000);
      if (!option) {
        const diagnostics = await this.browser.saveDiagnostics(page, `filter-${key}-${value}`);
        throw new ConnectorError("FILTER_UNAVAILABLE", `Value '${value}' is unavailable for filter '${labels[0]}'.`, {
          key,
          value,
          diagnostics,
        });
      }
      await option.click();
      const selectedName = new RegExp(
        `^Remove\\s+${escapeRegex(uiFilterLabel)}\\s+filter:\\s*[\"“”]?${escapeRegex(displayValue)}[\"“”]?$`,
        "i",
      );
      const selected = await waitForFirstVisible([page.getByLabel(selectedName)], 2_000);
      if (!selected) {
        const diagnostics = await this.browser.saveDiagnostics(page, `filter-not-selected-${key}-${value}`);
        throw new ConnectorError(
          "FILTER_UNAVAILABLE",
          `Value '${value}' did not remain selected for filter '${labels[0]}'.`,
          { key, value, diagnostics },
        );
      }
    }
    await page.keyboard.press("Escape").catch(() => undefined);
  }

  private async findFilterTrigger(page: Page, panel: Locator, labels: readonly string[]): Promise<Locator | null> {
    const candidates: Locator[] = [
      panel.locator('button[data-x-search-filter="container-toggle"]'),
      panel.locator('button[aria-expanded]').first(),
    ];
    for (const label of labels) {
      const expression = new RegExp(`^${escapeRegex(label)}(?:\\s|$)`, "i");
      candidates.push(page.getByRole("button", { name: expression }));
      candidates.push(page.getByText(label, { exact: true }).locator("xpath=ancestor::button[1]"));
    }
    return firstVisible(candidates);
  }

  private async extractPeople(page: Page): Promise<PersonSummary[]> {
    await Promise.race([
      page.locator(resultCardSelector).first().waitFor({ state: "visible" }),
      page.getByText(/no results/i).first().waitFor({ state: "visible" }),
    ]).catch(() => undefined);

    const people = await page.locator(resultCardSelector).evaluateAll((cards) => {
      const result = [];
      for (const card of cards) {
        const link = card.querySelector<HTMLAnchorElement>('a[href*="/sales/lead/"], a[href*="/in/"]');
        const nameNode = card.querySelector('[data-anonymize="person-name"]');
        const titleNode = card.querySelector('[data-anonymize="title"]');
        const companyNode = card.querySelector('[data-anonymize="company-name"]');
        const locationNode = card.querySelector('[data-anonymize="location"]');
        const subtitleNode = card.querySelector(".artdeco-entity-lockup__subtitle");
        const name =
          nameNode?.textContent?.replace(/\s+/g, " ").trim() ||
          link?.textContent?.replace(/\s+/g, " ").trim() ||
          null;
        const title = titleNode?.textContent?.replace(/\s+/g, " ").trim() || null;
        const subtitle = subtitleNode?.textContent?.replace(/\s+/g, " ").trim() || "";
        const company =
          companyNode?.textContent?.replace(/\s+/g, " ").trim() ||
          (title && subtitle.startsWith(title) ? subtitle.slice(title.length).replace(/^[·|\-\s]+/, "").trim() : null) ||
          null;
        const location = locationNode?.textContent?.replace(/\s+/g, " ").trim() || null;
        result.push({
          name,
          title,
          company,
          location,
          profileUrl: link?.href ?? "",
          rawText: ((card as HTMLElement).innerText ?? card.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 2_000),
        });
      }
      return result;
    });
    const unique = new Map<string, PersonSummary>();
    for (const person of people) {
      if (!person.profileUrl) continue;
      const normalized = normalizeLinkedInUrl(person.profileUrl);
      if (!unique.has(normalized)) unique.set(normalized, { ...person, profileUrl: normalized });
    }
    if (unique.size === 0) {
      const noResults = await anyVisible(page.getByText(/no (search )?results|0 results/i));
      if (!noResults) {
        const diagnostics = await this.browser.saveDiagnostics(page, "search-results-not-found");
        const pageText = cleanText(await page.locator("body").innerText().catch(() => "")).slice(0, 1_500);
        throw new ConnectorError("UI_CHANGED", "No result cards or explicit empty state were found.", {
          url: page.url(),
          pageText,
          diagnostics,
        });
      }
    }
    return [...unique.values()];
  }

  private async hasNextPage(page: Page): Promise<boolean> {
    const next = await this.nextButton(page);
    return Boolean(next && (await next.isEnabled().catch(() => false)));
  }

  private async goToNextPage(page: Page): Promise<boolean> {
    const next = await this.nextButton(page);
    if (!next || !(await next.isEnabled().catch(() => false))) return false;
    const oldFirst = await firstAttribute(page.locator(resultCardSelector).first().locator("a").first(), "href");
    await next.click();
    if (oldFirst) {
      const moved = await page
        .waitForFunction(
          (oldHref) => document.querySelector('a[href*="/sales/lead/"]')?.getAttribute("href") !== oldHref,
          oldFirst,
          { timeout: 10_000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!moved) {
        const diagnostics = await this.browser.saveDiagnostics(page, "pagination-did-not-advance");
        throw new ConnectorError("UI_CHANGED", "The Next action did not advance to a different result page.", {
          diagnostics,
        });
      }
    }
    return true;
  }

  private nextButton(page: Page): Promise<Locator | null> {
    return firstVisible([
      page.getByRole("button", { name: /^next$/i }),
      page.locator('button[aria-label*="next" i]'),
    ]);
  }

  private async openMessageComposer(page: Page): Promise<Locator> {
    const main = page.locator("main, [role=main]").first();
    const button = await firstVisible([
      main.getByRole("button", { name: /^message$/i }),
      main.getByRole("button", { name: /inmail/i }),
      main.getByRole("link", { name: /^message$/i }),
    ]);
    if (!button) throw new ConnectorError("NOT_FOUND", "Message or InMail is not available for this profile.");
    await button.click();
    const dialog = await visibleDialog(page);
    if (!dialog) throw new ConnectorError("UI_CHANGED", "Message composer did not open.");
    return dialog;
  }

  private findConnectButton(scope: Page | Locator): Promise<Locator | null> {
    return firstVisible([
      scope.getByRole("button", { name: /^connect$/i }),
      scope.getByRole("link", { name: /^connect$/i }),
    ]);
  }
}

export function parseSearchCursor(cursor?: string): { page: number; offset: number } {
  if (!cursor) return { page: 1, offset: 0 };
  const match = /^page:([1-9]\d*)(?::offset:(\d+))?$/.exec(cursor);
  if (!match) throw new ConnectorError("INVALID_INPUT", `Invalid search cursor '${cursor}'.`);
  return { page: Number(match[1]), offset: Number(match[2] ?? 0) };
}

export function formatSearchCursor(page: number, offset: number): string {
  return offset > 0 ? `page:${page}:offset:${offset}` : `page:${page}`;
}

export function filterUiValue(key: FilterKey, value: string): string {
  if (key === "currentTitles" || key === "pastTitles") {
    const values: Record<string, string> = {
      CEO: "Chief Executive Officer",
    };
    return values[value] ?? value;
  }
  if (key === "companyHeadcounts") {
    const values: Record<string, string> = {
      "501-1000": "501-1,000",
      "1001-5000": "1,001-5,000",
      "5001-10000": "5,001-10,000",
      "10001+": "10,001+",
    };
    return values[value] ?? value;
  }
  if (key === "connectionDegrees") {
    const values: Record<string, string> = {
      "1st": "1st degree connections",
      "2nd": "2nd degree connections",
      "3rd+": "3rd+ degree connections",
    };
    return values[value] ?? value;
  }
  return value;
}

function hasSearchCriteria(filters: SearchFilters): boolean {
  return Object.values(filters).some((value) => (Array.isArray(value) ? value.length > 0 : Boolean(value)));
}

function searchSignature(filters: SearchFilters): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(filters)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value]),
    ),
  );
}

async function firstVisible(locators: Locator[]): Promise<Locator | null> {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function waitForFirstVisible(locators: Locator[], timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const locator = await firstVisible(locators);
    if (locator) return locator;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

async function anyVisible(locator: Locator): Promise<boolean> {
  return (await firstVisible([locator])) !== null;
}

async function visibleDialog(page: Page): Promise<Locator | null> {
  return lastVisible([page.getByRole("dialog"), page.locator('[role="dialog"]')]);
}

async function lastVisible(locators: Locator[]): Promise<Locator | null> {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function outgoingMessageVisible(page: Page, dialog: Locator, text: string): Promise<boolean> {
  const outgoingSelector = [
    '[data-direction="outgoing"]',
    '[data-message-direction="outgoing"]',
    '[class*="outbound"]',
    ".msg-s-message-list__event--outbound",
  ].join(", ");
  return (
    (await anyVisible(dialog.locator(outgoingSelector).getByText(text, { exact: true }))) ||
    (await anyVisible(page.locator(outgoingSelector).getByText(text, { exact: true })))
  );
}

async function findVisibleFilterInput(scope: Page | Locator): Promise<Locator | null> {
  const inputs = scope.locator('input[type="text"], input:not([type])');
  const count = await inputs.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const input = inputs.nth(index);
    if (!(await input.isVisible().catch(() => false))) continue;
    const placeholder = (await input.getAttribute("placeholder")) ?? "";
    if (/add|search|title|company|location|industry|geograph/i.test(placeholder) || count === 1) return input;
  }
  return null;
}

async function hasVisibleFilterChoices(panel: Locator): Promise<boolean> {
  return anyVisible(
    panel.locator('[role="option"], [role="checkbox"], [data-x-search-filter-typeahead-suggestion]'),
  );
}

async function waitForFilterPanelReady(panel: Locator, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await findVisibleFilterInput(panel)) || (await hasVisibleFilterChoices(panel))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function typeIntoDynamicFilter(panel: Locator, initialInput: Locator, value: string): Promise<void> {
  let input: Locator | null = initialInput;
  for (let attempt = 0; attempt < 3 && input; attempt += 1) {
    await input.fill("");
    await input.focus();
    await input.pressSequentially(value, { delay: 75 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const current = await findVisibleFilterInput(panel);
    if (current && (await current.inputValue().catch(() => "")) === value) return;
    input = current;
  }
  throw new ConnectorError("UI_CHANGED", "The filter input did not retain the requested value.", { value });
}

async function firstText(locator: Locator): Promise<string | null> {
  const visible = await firstVisible([locator]);
  if (!visible) return null;
  const value = cleanText(await visible.innerText().catch(() => ""));
  return value || null;
}

async function firstAttribute(locator: Locator, name: string): Promise<string | null> {
  const visible = await firstVisible([locator]);
  return visible ? visible.getAttribute(name) : null;
}

async function sectionText(scope: Locator, heading: RegExp, maxLength: number): Promise<string | null> {
  const sections = scope.locator("section");
  const count = await sections.count();
  for (let index = 0; index < count; index += 1) {
    const section = sections.nth(index);
    const title = await section.locator("h1, h2, h3").first().innerText({ timeout: 500 }).catch(() => "");
    if (heading.test(cleanText(title))) {
      const value = cleanText(await section.innerText({ timeout: 1_000 }).catch(() => "")).slice(0, maxLength);
      return value || null;
    }
  }
  return null;
}

async function sectionLines(scope: Locator, heading: RegExp, maxLines: number): Promise<string[]> {
  const sections = scope.locator("section");
  const count = await sections.count();
  for (let index = 0; index < count; index += 1) {
    const section = sections.nth(index);
    const title = await section.locator("h1, h2, h3").first().innerText({ timeout: 500 }).catch(() => "");
    if (!heading.test(cleanText(title))) continue;
    return (await section.innerText({ timeout: 1_000 }).catch(() => ""))
      .split(/\r?\n/)
      .map(cleanText)
      .filter(Boolean)
      .slice(1, maxLines + 1);
  }
  return [];
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}
