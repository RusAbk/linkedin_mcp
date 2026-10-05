import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { SessionStatus } from "../browser/browser-manager.js";
import type { AppConfig } from "../config.js";
import { ConnectorError, type ConnectorErrorCode } from "../errors.js";
import type { ProfileBatchResult, ProfileDetails, SearchPeopleInput, SearchResult } from "../linkedin/types.js";
import type { OperationRecord } from "../storage/operation-store.js";
import type { ConnectorClient, WorkerHealth, WorkerMethod, WorkerResponse } from "./protocol.js";
import { readOrCreateWorkerToken } from "./worker-token.js";

export class WorkerClient implements ConnectorClient {
  private startPromise: Promise<void> | null = null;
  private tokenPromise: Promise<string> | null = null;

  constructor(private readonly config: AppConfig) {}

  async health(): Promise<WorkerHealth> {
    await this.ensureWorker();
    return this.request<WorkerHealth>("health", {}, 3_000);
  }

  async sessionStatus(): Promise<SessionStatus> {
    return this.call<SessionStatus>("sessionStatus", {});
  }

  async searchPeople(input: SearchPeopleInput): Promise<SearchResult> {
    return this.call<SearchResult>("searchPeople", input);
  }

  async getProfile(profileUrl: string): Promise<ProfileDetails> {
    return this.call<ProfileDetails>("getProfile", { profileUrl });
  }

  async getProfiles(profileUrls: string[]): Promise<ProfileBatchResult> {
    return this.call<ProfileBatchResult>("getProfiles", { profileUrls });
  }

  async sendMessage(input: {
    operationId: string;
    profileUrl: string;
    text: string;
    commit: boolean;
  }): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("sendMessage", input);
  }

  async sendConnection(input: {
    operationId: string;
    profileUrl: string;
    note?: string;
    commit: boolean;
  }): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("sendConnection", input);
  }

  async getOperation(operationId: string): Promise<OperationRecord> {
    return this.call<OperationRecord>("getOperation", { operationId });
  }

  async openLogin(): Promise<{ url: string }> {
    return this.call<{ url: string }>("openLogin", {});
  }

  async inspectPage(url: string): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("inspectPage", { url });
  }

  async stop(): Promise<void> {
    try {
      await this.request("shutdown", {}, 3_000);
    } catch (error) {
      if (!isConnectionFailure(error)) throw error;
    }
  }

  async close(): Promise<void> {
    // The worker deliberately outlives individual MCP and CLI processes.
  }

  private async call<T>(method: WorkerMethod, params: unknown): Promise<T> {
    await this.ensureWorker();
    return this.request<T>(method, params, this.config.navigationTimeoutMs + this.config.defaultTimeoutMs + 30_000);
  }

  private async ensureWorker(): Promise<void> {
    if (await this.isHealthy()) return;
    if (!this.config.workerAutoStart) {
      throw new ConnectorError(
        "BROWSER_ERROR",
        `Browser worker is not running at ${this.workerUrl}. Start it with npm run worker.`,
      );
    }
    this.startPromise ??= this.startWorker();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startWorker(): Promise<void> {
    await this.getToken();
    const entry = workerEntryPoint();
    const args = entry.endsWith(".ts") ? ["--import", "tsx", entry] : [entry];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LINKEDIN_DATA_DIR: this.config.dataDir,
      LINKEDIN_PROFILE_DIR: this.config.profileDir,
      LINKEDIN_ACTION_MODE: this.config.actionMode,
      LINKEDIN_HEADLESS: String(this.config.headless),
      LINKEDIN_LOCALE: this.config.locale,
      LINKEDIN_WORKER_HOST: this.config.workerHost,
      LINKEDIN_WORKER_PORT: String(this.config.workerPort),
      LINKEDIN_WORKER_TOKEN_PATH: this.config.workerTokenPath,
      LINKEDIN_WORKER_LOG_PATH: this.config.workerLogPath,
      LINKEDIN_WORKER_AUTOSTART: "false",
      LINKEDIN_DEFAULT_TIMEOUT_MS: String(this.config.defaultTimeoutMs),
      LINKEDIN_NAVIGATION_TIMEOUT_MS: String(this.config.navigationTimeoutMs),
    };
    if (this.config.browserChannel) env.LINKEDIN_BROWSER_CHANNEL = this.config.browserChannel;

    const child = spawn(process.execPath, args, {
      cwd: this.config.projectRoot,
      env,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", () => undefined);
    child.unref();

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await this.isHealthy()) return;
      await delay(100);
    }
    throw new ConnectorError("BROWSER_ERROR", `Browser worker did not start. See ${this.config.workerLogPath}.`);
  }

  private async isHealthy(): Promise<boolean> {
    try {
      await this.request<WorkerHealth>("health", {}, 750);
      return true;
    } catch (error) {
      if (error instanceof WorkerAuthenticationError) throw error;
      return false;
    }
  }

  private async request<T>(method: WorkerMethod, params: unknown, timeoutMs: number): Promise<T> {
    const token = await this.getToken();
    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    try {
      response = await fetch(`${this.workerUrl}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ method, params }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new WorkerConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 401) {
      throw new WorkerAuthenticationError(
        `Another service is using ${this.workerUrl}, or the worker token does not match.`,
      );
    }
    const payload = (await response.json().catch(() => null)) as WorkerResponse | null;
    if (!payload) throw new WorkerConnectionError(`Worker returned HTTP ${response.status} without JSON.`);
    if (!payload.ok) {
      throw new ConnectorError(
        isConnectorErrorCode(payload.error.code) ? payload.error.code : "BROWSER_ERROR",
        payload.error.message,
        payload.error.details,
      );
    }
    return payload.data as T;
  }

  private getToken(): Promise<string> {
    this.tokenPromise ??= readOrCreateWorkerToken(this.config);
    return this.tokenPromise;
  }

  private get workerUrl(): string {
    return `http://${this.config.workerHost}:${this.config.workerPort}`;
  }
}

class WorkerConnectionError extends Error {}
class WorkerAuthenticationError extends Error {}

function workerEntryPoint(): string {
  const source = fileURLToPath(new URL("../browser-worker.ts", import.meta.url));
  if (fs.existsSync(source)) return source;
  return fileURLToPath(new URL("../browser-worker.js", import.meta.url));
}

function isConnectionFailure(error: unknown): boolean {
  return error instanceof WorkerConnectionError || error instanceof TypeError;
}

function isConnectorErrorCode(value: string): value is ConnectorErrorCode {
  return [
    "AUTH_REQUIRED",
    "CHALLENGE_REQUIRED",
    "FILTER_UNAVAILABLE",
    "INVALID_INPUT",
    "NOT_FOUND",
    "UI_CHANGED",
    "ACTION_DISABLED",
    "ACTION_CONFLICT",
    "ACTION_OUTCOME_UNKNOWN",
    "LIMIT_REACHED",
    "BROWSER_ERROR",
  ].includes(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
