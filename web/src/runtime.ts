import path from "node:path";
import type { Page } from "playwright";
import { createApp, type ConnectorApp } from "../../src/app.js";
import { EmbeddedConnectorClient } from "../../src/worker/connector-client.js";
import type { ConnectorClient } from "../../src/worker/protocol.js";
import { ConnectorError } from "../../src/errors.js";
import { SerialQueue } from "../../src/browser/serial-queue.js";
import type { User } from "./users.js";
import { LoginScreen } from "./login-screen.js";
import { loginPageState } from "./login-navigation.js";
import { browserTimeout } from "./browser-timeout.js";
import { randomUUID } from "node:crypto";

export interface LoginFrame { image?: string; version?: number; width: number; height: number; url: string; complete: boolean; blocked?: boolean }
export type BrowserInput = { type: "click"; x: number; y: number } | { type: "text"; text: string } | { type: "key"; key: string } | { type: "scroll"; delta: number };
export interface UserRuntime {
  client: ConnectorClient;
  openLogin(): Promise<void>;
  frame(): Promise<LoginFrame>;
  input(input: BrowserInput): Promise<void>;
  finishLogin(): Promise<void>;
  close(): Promise<void>;
}

class Runtime implements UserRuntime {
  private readonly app: ConnectorApp;
  private readonly queue = new SerialQueue();
  private loginUntil = 0;
  private screen: LoginScreen | null = null;
  private pending = 0;
  readonly client: ConnectorClient;
  constructor(user: User, dataRoot: string, projectRoot: string) {
    const directory = path.join(dataRoot, "users", user.id);
    this.app = createApp({
      projectRoot,
      dataDir: directory,
      profileDir: path.join(directory, "browser-profile"),
      diagnosticsDir: path.join(directory, "diagnostics"),
      databasePath: path.join(directory, "operations.sqlite"),
      workerMode: "embedded",
      actionMode: user.action_mode,
    });
    const raw = new EmbeddedConnectorClient(this.app);
    this.client = new Proxy(raw, {
      get: (target, key) => {
        const method = Reflect.get(target, key);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => {
          if (this.pending >= 20) return Promise.reject(new ConnectorError("LIMIT_REACHED", "Очередь этого пользователя заполнена."));
          this.pending++;
          return this.queue.run(async () => {
            try {
              if (this.loginUntil > Date.now() && !["health", "getOperation", "close", "sessionStatus"].includes(String(key))) throw new ConnectorError("AUTH_REQUIRED", "В портале открыт вход в LinkedIn. Завершите его перед вызовом MCP.");
              if (key === "sessionStatus") {
                await this.app.browser.runExclusiveOn("search", async page => {
                  if (/linkedin\.com\/sales\/login/i.test(page.url())) await page.goto("https://www.linkedin.com/sales/home", { waitUntil: "domcontentloaded" });
                });
              }
              return await method.apply(target, args);
            } finally { this.pending--; }
          });
        };
      },
    });
  }
  async openLogin() {
    const trace = randomUUID().slice(0, 8), started = performance.now();
    const stage = (name: string) => console.info(`LinkedIn login ${trace}: ${name} (${Math.round(performance.now() - started)}ms)`);
    stage("queued");
    await this.queue.run(async () => {
      stage("preparing Chrome");
      await this.stopScreen();
      await this.app.browser.runExclusive(async page => {
        stage("Chrome page ready");
        const screen = new LoginScreen(page);
        try {
          await screen.start();
          stage("frame stream ready");
          // Resume verification instead of restarting it after a portal error.
          // Start rendering first and wait only for the navigation response.
          if (loginPageState(page.url()) === "external") await page.goto("https://www.linkedin.com/login", { waitUntil: "commit", timeout: 15_000 });
          stage("navigation committed");
          this.screen = screen;
        }
        catch (error) { await screen.close(); throw error; }
      });
      this.loginUntil = Date.now() + 15 * 60_000;
      stage("ready");
    });
  }
  private async loginTask<T>(task: (page: Page) => Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      if (this.loginUntil <= Date.now()) throw new ConnectorError("AUTH_REQUIRED", "Нажмите «Войти в LinkedIn», чтобы открыть вход снова.");
      return this.app.browser.runExclusive(async page => { await browserTimeout(page.bringToFront(), 5_000, "Chrome не отвечает на ввод. Закройте браузер и откройте вход снова."); return task(page); });
    });
  }
  async frame(): Promise<LoginFrame> {
    const screen = this.screen;
    if (this.loginUntil <= Date.now() || !screen || screen.page.isClosed()) {
      await this.stopScreen();
      throw new ConnectorError("AUTH_REQUIRED", "Нажмите «Войти в LinkedIn», чтобы открыть вход снова.");
    }
    const page = screen.page, viewport = page.viewportSize() ?? { width: 1440, height: 1000 };
    const url = page.url();
    const state = loginPageState(url), complete = state === "complete";
    if (complete) { this.loginUntil = 0; await this.stopScreen(); return { ...viewport, url, complete }; }
    // Cached frames are read independently of input/navigation operations.
    return { ...viewport, url, complete, blocked: state === "external", ...screen.read() };
  }
  input(input: BrowserInput) {
    return this.loginTask(async page => {
      if (loginPageState(page.url()) === "external") throw new ConnectorError("AUTH_REQUIRED", "Ввод разрешён только на HTTPS-страницах LinkedIn. Текущий адрес показан над окном.");
      if (input.type === "click") await page.mouse.click(input.x, input.y);
      if (input.type === "text") await page.keyboard.insertText(input.text);
      if (input.type === "key") await page.keyboard.press(input.key);
      if (input.type === "scroll") await page.mouse.wheel(0, input.delta);
    });
  }
  private async stopScreen() { const screen = this.screen; this.screen = null; await screen?.close(); }
  async finishLogin() { await this.queue.run(async () => { this.loginUntil = 0; await this.stopScreen(); }); }
  async close() { await this.queue.run(async () => { this.loginUntil = 0; await this.stopScreen(); await this.app.close(); }); }
}

export class RuntimePool {
  private readonly releasing = new Set<string>();
  private readonly entries = new Map<string, UserRuntime>();
  constructor(dataRoot: string, projectRoot: string, private readonly max: number, private readonly factory = (user: User) => new Runtime(user, dataRoot, projectRoot)) {}
  get(user: User): UserRuntime {
    if (this.releasing.has(user.id)) throw new ConnectorError("BROWSER_ERROR", "Браузер завершает работу. Повторите запрос через несколько секунд.");
    const existing = this.entries.get(user.id);
    if (existing) return existing;
    if (this.entries.size >= this.max) throw new ConnectorError("LIMIT_REACHED", "Достигнут лимит активных браузеров. Администратор может освободить браузер или увеличить WEB_MAX_BROWSERS.");
    const runtime = this.factory(user);
    this.entries.set(user.id, runtime);
    return runtime;
  }
  async release(id: string) {
    const entry = this.entries.get(id);
    if (entry && !this.releasing.has(id)) {
      this.releasing.add(id);
      try { await entry.close(); this.entries.delete(id); }
      finally { this.releasing.delete(id); }
    }
  }
  async close() { for (const id of this.entries.keys()) await this.release(id); }
}
