import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConnectorError } from "../errors.js";

export type OperationStatus = "pending" | "executing" | "succeeded" | "failed" | "unknown";

export interface OperationRecord {
  id: string;
  kind: "send_message" | "send_connection";
  status: OperationStatus;
  requestHash: string;
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

interface OperationRow {
  id: string;
  kind: OperationRecord["kind"];
  status: OperationStatus;
  request_hash: string;
  request_json: string;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

export class OperationStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        result_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS operations_status_idx ON operations(status);
    `);
  }

  reserve(
    id: string,
    kind: OperationRecord["kind"],
    request: Record<string, unknown>,
  ): { record: OperationRecord; isNew: boolean } {
    const requestJson = stableStringify(request);
    const requestHash = createHash("sha256").update(requestJson).digest("hex");
    const existing = this.get(id);
    if (existing) {
      if (existing.kind !== kind || existing.requestHash !== requestHash) {
        throw new ConnectorError(
          "ACTION_CONFLICT",
          `Operation '${id}' was already used with different parameters.`,
          { operationId: id, existingKind: existing.kind },
        );
      }
      return { record: existing, isNew: false };
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO operations
          (id, kind, status, request_hash, request_json, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(id, kind, requestHash, requestJson, now, now);
    return { record: this.getRequired(id), isNew: true };
  }

  get(id: string): OperationRecord | null {
    const row = this.db.prepare("SELECT * FROM operations WHERE id = ?").get(id) as OperationRow | undefined;
    return row ? mapRow(row) : null;
  }

  update(
    id: string,
    status: OperationStatus,
    values: { result?: Record<string, unknown> | null; error?: Record<string, unknown> | null } = {},
  ): OperationRecord {
    const now = new Date().toISOString();
    const resultJson = values.result === undefined ? undefined : JSON.stringify(values.result);
    const errorJson = values.error === undefined ? undefined : JSON.stringify(values.error);

    if (resultJson !== undefined || errorJson !== undefined) {
      const current = this.getRequired(id);
      this.db
        .prepare("UPDATE operations SET status = ?, result_json = ?, error_json = ?, updated_at = ? WHERE id = ?")
        .run(
          status,
          resultJson === undefined ? JSON.stringify(current.result) : resultJson,
          errorJson === undefined ? JSON.stringify(current.error) : errorJson,
          now,
          id,
        );
    } else {
      this.db.prepare("UPDATE operations SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
    }
    return this.getRequired(id);
  }

  close(): void {
    this.db.close();
  }

  private getRequired(id: string): OperationRecord {
    const record = this.get(id);
    if (!record) throw new Error(`Operation '${id}' disappeared from storage.`);
    return record;
  }
}

function mapRow(row: OperationRow): OperationRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    requestHash: row.request_hash,
    request: JSON.parse(row.request_json) as Record<string, unknown>,
    result: row.result_json ? (JSON.parse(row.result_json) as Record<string, unknown>) : null,
    error: row.error_json ? (JSON.parse(row.error_json) as Record<string, unknown>) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
