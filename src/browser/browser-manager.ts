import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { AppConfig } from "../config.js";
import { ConnectorError } from "../errors.js";
import { SerialQueue } from "./serial-queue.js";

export interface SessionStatus {
  state: "authenticated" | "auth_required" | "challenge_required" | "unavailable";
  url: string;
  title: string;
  salesNavigatorAvailable: boolean;
  actionMode: AppConfig["actionMode"];
}

export class BrowserManager {
  private context: BrowserContext | null = null;
  private readonly pages = new Map<string, Page>();
  private readonly queue = new SerialQueue();

  constructor(private readonly config: AppConfig) {}

  runExclusive<T>(task: (page: Page) => Promise<T>): Promise<T> {
    return this.runExclusiveOn("main", task);
  }

  runExclusiveOn<T>(role: "main" | "search" | "profile", task: (page: Page) => Promise<T>): Promise<T> {
    return this.queue.run(async () => task(await this.getPage(role)));
  }

  async getPage(role: "main" | "search" | "profile" = "main"): Promise<Page> {
    const context = await this.getContext();
    const remembered = this.pages.get(role);
    if (remembered && !remembered.isClosed()) return remembered;

    const assigned = new Set([...this.pages.values()].filter((page) => !page.isClosed()));
    const candidates = context.pages().filter((page) => !assigned.has(page));
    const matching = candidates.find((page) => pageMatchesRole(page, role));
    const page = matching ?? candidates.find((candidate) => candidate.url() === "about:blank") ?? (await context.newPage());
    page.setDefaultTimeout(this.config.defaultTimeoutMs);
    page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    this.pages.set(role, page);
    return page;
  }

  async warmUp(): Promise<void> {
    await this.runExclusiveOn("search", async (page) => {
      if (!page.url().includes("/sales/search/people")) {
        await page.goto("https://www.linkedin.com/sales/search/people", { waitUntil: "domcontentloaded" });
      }
      await this.waitForLinkedInReady(page);
    });
  }

  stats(): { running: boolean; pages: number; roles: string[] } {
    return {
      running: this.context !== null,
      pages: this.context?.pages().filter((page) => !page.isClosed()).length ?? 0,
      roles: [...this.pages.entries()].filter(([, page]) => !page.isClosed()).map(([role]) => role),
    };
  }

  async status(navigate = true): Promise<SessionStatus> {
    return this.runExclusiveOn("search", async (page) => {
      if (navigate && (!page.url().includes("/sales/") || page.url() === "about:blank")) {
        await page.goto("https://www.linkedin.com/sales/home", { waitUntil: "domcontentloaded" });
      }
      await this.waitForLinkedInReady(page);
      const url = page.url();
      const title = await page.title().catch(() => "");
      if (isChallengeUrl(url)) {
        return { state: "challenge_required", url, title, salesNavigatorAvailable: false, actionMode: this.config.actionMode };
      }
      if (isLoginUrl(url) || (await isLoginPage(page))) {
        return { state: "auth_required", url, title, salesNavigatorAvailable: false, actionMode: this.config.actionMode };
      }
      const salesNavigatorAvailable = url.includes("/sales/") && !/join|upgrade|subscribe/i.test(url);
      return {
        state: salesNavigatorAvailable ? "authenticated" : "unavailable",
        url,
        title,
        salesNavigatorAvailable,
        actionMode: this.config.actionMode,
      };
    });
  }

  async assertAuthenticated(page: Page): Promise<void> {
    await this.waitForLinkedInReady(page);
    const url = page.url();
    if (isChallengeUrl(url)) {
      throw new ConnectorError("CHALLENGE_REQUIRED", "LinkedIn requires an interactive security check.", { url });
    }
    if (isLoginUrl(url) || (await isLoginPage(page))) {
      throw new ConnectorError("AUTH_REQUIRED", "LinkedIn login is required. Run `npm run login`.", { url });
    }
  }

  async saveDiagnostics(
    page: Page,
    label: string,
  ): Promise<{
    screenshot: string | null;
    html: string | null;
    htmlCapturedAt: string;
    screenshotCapturedAt: string;
    errors?: string[];
  }> {
    await fs.mkdir(this.config.diagnosticsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeLabel = label.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60);
    const base = path.join(this.config.diagnosticsDir, `${timestamp}-${safeLabel}`);
    const screenshot = `${base}.png`;
    const html = `${base}.html`;
    const errors: string[] = [];
    let savedScreenshot: string | null = screenshot;
    let savedHtml: string | null = html;
    const htmlCapturedAt = new Date().toISOString();
    await page
      .content()
      .then((content) => fs.writeFile(html, content, "utf8"))
      .catch((error: unknown) => {
        savedHtml = null;
        errors.push(`html: ${error instanceof Error ? error.message : String(error)}`);
      });
    const screenshotCapturedAt = new Date().toISOString();
    await page.screenshot({ path: screenshot, fullPage: true }).catch((error: unknown) => {
      savedScreenshot = null;
      errors.push(`screenshot: ${error instanceof Error ? error.message : String(error)}`);
    });
    return {
      screenshot: savedScreenshot,
      html: savedHtml,
      htmlCapturedAt,
      screenshotCapturedAt,
      ...(errors.length ? { errors } : {}),
    };
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = null;
    this.pages.clear();
  }

  private async waitForLinkedInReady(page: Page): Promise<void> {
    await Promise.race([
      page.waitForURL((url) => /linkedin\.com\/(sales\/login|login|checkpoint|challenge|authwall)/i.test(url.href), {
        timeout: this.config.navigationTimeoutMs,
      }),
      page.waitForFunction(
        () =>
          (document.body?.innerText.trim().length ?? 0) > 0 ||
          Boolean(document.querySelector('input, main, [role="main"]')),
        null,
        { timeout: this.config.navigationTimeoutMs },
      ),
    ]).catch(() => undefined);
  }

  private async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    await fs.mkdir(this.config.profileDir, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.config.profileDir, {
      headless: this.config.headless,
      ...(this.config.browserChannel ? { channel: this.config.browserChannel } : {}),
      locale: this.config.locale,
      viewport: { width: 1440, height: 1000 },
      args: ["--disable-notifications", "--disable-quic"],
    });
    this.context.once("close", () => {
      this.context = null;
      this.pages.clear();
    });
    return this.context;
  }
}

function pageMatchesRole(page: Page, role: "main" | "search" | "profile"): boolean {
  const url = page.url();
  if (role === "search") return url.includes("/sales/search/people");
  if (role === "profile") return /linkedin\.com\/(?:in|sales\/lead)\//i.test(url);
  return url.includes("linkedin.com") && !url.includes("/sales/search/people");
}

function isLoginUrl(url: string): boolean {
  return /linkedin\.com\/(login|uas\/login|authwall|sales\/login)/i.test(url);
}

function isChallengeUrl(url: string): boolean {
  return /linkedin\.com\/(checkpoint|challenge)/i.test(url);
}

async function hasVisible(page: Page, selector: string): Promise<boolean> {
  const locator = page.locator(selector);
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

async function isLoginPage(page: Page): Promise<boolean> {
  if (await hasVisible(page, 'input[type="password"], input[name="session_key"], input[name="session_password"]')) {
    return true;
  }
  const heading = await page.getByText(/sign in to sales navigator/i).first().isVisible().catch(() => false);
  return heading;
}
