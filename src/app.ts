import { BrowserManager } from "./browser/browser-manager.js";
import { loadConfig, type AppConfig } from "./config.js";
import { ConnectorService } from "./connector-service.js";
import { SalesNavigatorAdapter } from "./linkedin/sales-navigator-adapter.js";
import { OperationStore } from "./storage/operation-store.js";

export interface ConnectorApp {
  config: AppConfig;
  browser: BrowserManager;
  adapter: SalesNavigatorAdapter;
  operations: OperationStore;
  service: ConnectorService;
  close(): Promise<void>;
}

export function createApp(overrides: Partial<AppConfig> = {}): ConnectorApp {
  const config = loadConfig(overrides);
  const browser = new BrowserManager(config);
  const adapter = new SalesNavigatorAdapter(browser);
  const operations = new OperationStore(config.databasePath);
  const service = new ConnectorService(config, browser, adapter, operations);
  return {
    config,
    browser,
    adapter,
    operations,
    service,
    async close() {
      await browser.close();
      operations.close();
    },
  };
}
