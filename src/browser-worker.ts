import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";
import { ConnectorError, errorPayload } from "./errors.js";
import {
  getProfileSchema,
  getProfilesSchema,
  isLinkedInUrl,
  searchPeopleSchema,
  sendConnectionSchema,
  sendMessageSchema,
} from "./linkedin/types.js";
import type { WorkerRequest } from "./worker/protocol.js";
import { readOrCreateWorkerToken } from "./worker/worker-token.js";

const operationSchema = z.object({ operationId: z.string().trim().min(8).max(128) }).strict();
const inspectSchema = z
  .object({ url: z.string().url().refine(isLinkedInUrl, "url must be an HTTPS linkedin.com URL") })
  .strict();
const emptySchema = z.object({}).strict();

export async function startBrowserWorker(config: AppConfig = loadConfig()): Promise<void> {
  const startedAt = new Date();
  const token = await readOrCreateWorkerToken(config);
  const app = createApp(config);
  await fs.mkdir(path.dirname(config.workerLogPath), { recursive: true });

  let shuttingDown = false;
  const log = async (message: string) => {
    await fs.appendFile(config.workerLogPath, `${new Date().toISOString()} ${message}\n`, "utf8").catch(() => undefined);
  };

  const server = http.createServer((request, response) => {
    void handleRequest(request, response).catch(async (error) => {
      await log(`request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      sendJson(response, 500, errorPayload(error));
    });
  });

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await log("stopping");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
  };

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== "/rpc") {
      sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Route not found." } });
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, 401, { ok: false, error: { code: "AUTH_REQUIRED", message: "Invalid worker token." } });
      return;
    }

    const body = (await readJson(request)) as Partial<WorkerRequest>;
    if (typeof body.method !== "string") {
      throw new ConnectorError("INVALID_INPUT", "Worker method is required.");
    }

    if (body.method === "health") {
      sendJson(response, 200, {
        ok: true,
        data: {
          pid: process.pid,
          startedAt: startedAt.toISOString(),
          uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1_000),
          browser: app.browser.stats(),
        },
      });
      return;
    }
    if (body.method === "shutdown") {
      emptySchema.parse(body.params ?? {});
      sendJson(response, 200, { ok: true, data: { stopping: true } });
      setImmediate(() => void shutdown().then(() => process.exit(0)));
      return;
    }

    const data = await dispatch(body.method, body.params ?? {});
    sendJson(response, 200, { ok: true, data });
  }

  async function dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "sessionStatus":
        emptySchema.parse(params);
        return app.service.sessionStatus();
      case "searchPeople":
        return app.service.searchPeople(searchPeopleSchema.parse(params));
      case "getProfile": {
        const input = getProfileSchema.parse(params);
        return app.service.getProfile(input.profileUrl);
      }
      case "getProfiles": {
        const input = getProfilesSchema.parse(params);
        return app.service.getProfiles(input.profileUrls);
      }
      case "sendMessage":
        return app.service.sendMessage(sendMessageSchema.parse(params));
      case "sendConnection":
        {
          const input = sendConnectionSchema.parse(params);
          return app.service.sendConnection({
            operationId: input.operationId,
            profileUrl: input.profileUrl,
            commit: input.commit,
            ...(input.note ? { note: input.note } : {}),
          });
        }
      case "getOperation": {
        const input = operationSchema.parse(params);
        return app.service.getOperation(input.operationId);
      }
      case "openLogin":
        emptySchema.parse(params);
        return app.browser.runExclusive(async (page) => {
          await page.goto("https://www.linkedin.com/sales/home", { waitUntil: "domcontentloaded" });
          return { url: page.url() };
        });
      case "inspectPage": {
        const input = inspectSchema.parse(params);
        await app.browser.runExclusive(async (page) => {
          await page.goto(input.url, { waitUntil: "domcontentloaded" });
          await app.browser.assertAuthenticated(page);
        });
        return app.adapter.inspectCurrentPage();
      }
      default:
        throw new ConnectorError("NOT_FOUND", `Unknown worker method '${method}'.`);
    }
  }

  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  process.once("uncaughtException", (error) => void log(`uncaught exception: ${error.stack ?? error.message}`));
  process.once("unhandledRejection", (error) => void log(`unhandled rejection: ${String(error)}`));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.workerPort, config.workerHost, () => resolve());
  });
  await log(`listening on http://${config.workerHost}:${config.workerPort} pid=${process.pid}`);
  void app.browser.warmUp().then(
    () => log("browser warm-up complete"),
    (error: unknown) => log(`browser warm-up failed: ${error instanceof Error ? error.message : String(error)}`),
  );
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new ConnectorError("INVALID_INPUT", "Worker request is too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ConnectorError("INVALID_INPUT", "Worker request must contain valid JSON.");
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function main(): Promise<void> {
  await startBrowserWorker();
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    const config = loadConfig();
    await fs.mkdir(path.dirname(config.workerLogPath), { recursive: true }).catch(() => undefined);
    await fs
      .appendFile(
        config.workerLogPath,
        `${new Date().toISOString()} fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
        "utf8",
      )
      .catch(() => undefined);
    process.exit(1);
  });
}
