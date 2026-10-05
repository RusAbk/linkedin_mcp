import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";

export async function readOrCreateWorkerToken(config: AppConfig): Promise<string> {
  const configured = process.env.LINKEDIN_WORKER_TOKEN?.trim();
  if (configured) return configured;

  await fs.mkdir(path.dirname(config.workerTokenPath), { recursive: true });
  try {
    const current = (await fs.readFile(config.workerTokenPath, "utf8")).trim();
    if (current) return current;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const token = randomBytes(32).toString("hex");
  try {
    await fs.writeFile(config.workerTokenPath, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const current = (await fs.readFile(config.workerTokenPath, "utf8")).trim();
    if (!current) throw new Error(`Worker token file is empty: ${config.workerTokenPath}`);
    return current;
  }
}
