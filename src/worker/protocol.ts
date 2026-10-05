import type { SessionStatus } from "../browser/browser-manager.js";
import type { ProfileBatchResult, ProfileDetails, SearchPeopleInput, SearchResult } from "../linkedin/types.js";
import type { OperationRecord } from "../storage/operation-store.js";

export interface WorkerHealth {
  pid: number;
  startedAt: string;
  uptimeSeconds: number;
  browser: {
    running: boolean;
    pages: number;
    roles: string[];
  };
}

export interface ConnectorClient {
  health(): Promise<WorkerHealth>;
  sessionStatus(): Promise<SessionStatus>;
  searchPeople(input: SearchPeopleInput): Promise<SearchResult>;
  getProfile(profileUrl: string): Promise<ProfileDetails>;
  getProfiles(profileUrls: string[]): Promise<ProfileBatchResult>;
  sendMessage(input: {
    operationId: string;
    profileUrl: string;
    text: string;
    commit: boolean;
  }): Promise<Record<string, unknown>>;
  sendConnection(input: {
    operationId: string;
    profileUrl: string;
    note?: string;
    commit: boolean;
  }): Promise<Record<string, unknown>>;
  getOperation(operationId: string): Promise<OperationRecord>;
  openLogin(): Promise<{ url: string }>;
  inspectPage(url: string): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export type WorkerMethod =
  | "health"
  | "sessionStatus"
  | "searchPeople"
  | "getProfile"
  | "getProfiles"
  | "sendMessage"
  | "sendConnection"
  | "getOperation"
  | "openLogin"
  | "inspectPage"
  | "shutdown";

export interface WorkerRequest {
  method: WorkerMethod;
  params?: unknown;
}

export type WorkerResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };
