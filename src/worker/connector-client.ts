import { createApp, type ConnectorApp } from "../app.js";
import { loadConfig, type AppConfig } from "../config.js";
import type { ConnectorClient, WorkerHealth } from "./protocol.js";
import { WorkerClient } from "./worker-client.js";

export function createConnectorClient(overrides: Partial<AppConfig> = {}): ConnectorClient {
  const config = loadConfig(overrides);
  return config.workerMode === "embedded" ? new EmbeddedConnectorClient(createApp(config)) : new WorkerClient(config);
}

class EmbeddedConnectorClient implements ConnectorClient {
  private readonly startedAt = new Date();

  constructor(private readonly app: ConnectorApp) {}

  async health(): Promise<WorkerHealth> {
    return {
      pid: process.pid,
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1_000),
      browser: this.app.browser.stats(),
    };
  }

  sessionStatus() {
    return this.app.service.sessionStatus();
  }

  searchPeople(input: Parameters<ConnectorApp["service"]["searchPeople"]>[0]) {
    return this.app.service.searchPeople(input);
  }

  getProfile(profileUrl: string) {
    return this.app.service.getProfile(profileUrl);
  }

  getProfiles(profileUrls: string[]) {
    return this.app.service.getProfiles(profileUrls);
  }

  sendMessage(input: Parameters<ConnectorApp["service"]["sendMessage"]>[0]) {
    return this.app.service.sendMessage(input);
  }

  sendConnection(input: Parameters<ConnectorApp["service"]["sendConnection"]>[0]) {
    return this.app.service.sendConnection(input);
  }

  async getOperation(operationId: string) {
    return this.app.service.getOperation(operationId);
  }

  async openLogin(): Promise<{ url: string }> {
    return this.app.browser.runExclusive(async (page) => {
      await page.goto("https://www.linkedin.com/sales/home", { waitUntil: "domcontentloaded" });
      return { url: page.url() };
    });
  }

  async inspectPage(url: string): Promise<Record<string, unknown>> {
    await this.app.browser.runExclusive(async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await this.app.browser.assertAuthenticated(page);
    });
    return this.app.adapter.inspectCurrentPage();
  }

  stop(): Promise<void> {
    return this.close();
  }

  close(): Promise<void> {
    return this.app.close();
  }
}
