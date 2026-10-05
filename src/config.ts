import path from "node:path";
import { fileURLToPath } from "node:url";

export type ActionMode = "review" | "execute";
export type WorkerMode = "daemon" | "embedded";

export interface AppConfig {
  projectRoot: string;
  dataDir: string;
  profileDir: string;
  diagnosticsDir: string;
  databasePath: string;
  headless: boolean;
  locale: string;
  actionMode: ActionMode;
  browserChannel: "chrome" | "msedge" | undefined;
  defaultTimeoutMs: number;
  navigationTimeoutMs: number;
  workerMode: WorkerMode;
  workerHost: string;
  workerPort: number;
  workerTokenPath: string;
  workerLogPath: string;
  workerAutoStart: boolean;
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function portEnv(value: string | undefined, fallback: number): number {
  const port = numberEnv(value, fallback);
  return Number.isInteger(port) && port <= 65_535 ? port : fallback;
}

function resolveFrom(root: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const inferredRoot = path.resolve(moduleDir, moduleDir.endsWith(`${path.sep}dist${path.sep}src`) ? "../.." : "..");
  const projectRoot = overrides.projectRoot ?? inferredRoot;
  const dataDir = overrides.dataDir ?? resolveFrom(projectRoot, process.env.LINKEDIN_DATA_DIR ?? ".data");
  const rawChannel = process.env.LINKEDIN_BROWSER_CHANNEL ?? "chrome";
  const browserChannel = rawChannel === "none" ? undefined : rawChannel === "msedge" ? "msedge" : "chrome";

  return {
    projectRoot,
    dataDir,
    profileDir:
      overrides.profileDir ?? resolveFrom(projectRoot, process.env.LINKEDIN_PROFILE_DIR ?? ".data/browser-profile"),
    diagnosticsDir: overrides.diagnosticsDir ?? path.join(dataDir, "diagnostics"),
    databasePath: overrides.databasePath ?? path.join(dataDir, "connector.sqlite"),
    headless: overrides.headless ?? booleanEnv(process.env.LINKEDIN_HEADLESS, false),
    locale: overrides.locale ?? process.env.LINKEDIN_LOCALE ?? "en-US",
    actionMode:
      overrides.actionMode ?? (process.env.LINKEDIN_ACTION_MODE === "execute" ? "execute" : "review"),
    browserChannel: overrides.browserChannel ?? browserChannel,
    defaultTimeoutMs:
      overrides.defaultTimeoutMs ?? numberEnv(process.env.LINKEDIN_DEFAULT_TIMEOUT_MS, 15_000),
    navigationTimeoutMs:
      overrides.navigationTimeoutMs ?? numberEnv(process.env.LINKEDIN_NAVIGATION_TIMEOUT_MS, 45_000),
    workerMode:
      overrides.workerMode ?? (process.env.LINKEDIN_WORKER_MODE === "embedded" ? "embedded" : "daemon"),
    workerHost: overrides.workerHost ?? process.env.LINKEDIN_WORKER_HOST ?? "127.0.0.1",
    workerPort: overrides.workerPort ?? portEnv(process.env.LINKEDIN_WORKER_PORT, 17_381),
    workerTokenPath:
      overrides.workerTokenPath ??
      resolveFrom(projectRoot, process.env.LINKEDIN_WORKER_TOKEN_PATH ?? ".data/browser-worker.token"),
    workerLogPath:
      overrides.workerLogPath ??
      resolveFrom(projectRoot, process.env.LINKEDIN_WORKER_LOG_PATH ?? ".data/browser-worker.log"),
    workerAutoStart:
      overrides.workerAutoStart ?? booleanEnv(process.env.LINKEDIN_WORKER_AUTOSTART, true),
  };
}
