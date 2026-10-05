import type { BrowserManager, SessionStatus } from "./browser/browser-manager.js";
import type { AppConfig } from "./config.js";
import { ActionOutcomeUnknownError, ConnectorError, errorPayload } from "./errors.js";
import type { SalesNavigatorAdapter } from "./linkedin/sales-navigator-adapter.js";
import {
  normalizeLinkedInUrl,
  type ProfileDetails,
  type ProfileBatchResult,
  type SearchPeopleInput,
  type SearchResult,
} from "./linkedin/types.js";
import type { OperationRecord, OperationStore } from "./storage/operation-store.js";

export class ConnectorService {
  constructor(
    private readonly config: AppConfig,
    private readonly browser: BrowserManager,
    private readonly adapter: SalesNavigatorAdapter,
    private readonly operations: OperationStore,
  ) {}

  sessionStatus(): Promise<SessionStatus> {
    return this.browser.status();
  }

  searchPeople(input: SearchPeopleInput): Promise<SearchResult> {
    return this.adapter.searchPeople(input.filters, input.limit, input.cursor);
  }

  getProfile(profileUrl: string): Promise<ProfileDetails> {
    return this.adapter.getProfile(profileUrl);
  }

  async getProfiles(profileUrls: string[]): Promise<ProfileBatchResult> {
    const profiles: ProfileDetails[] = [];
    const errors: ProfileBatchResult["errors"] = [];
    const uniqueUrls = [...new Set(profileUrls.map(normalizeLinkedInUrl))];
    for (const profileUrl of uniqueUrls) {
      try {
        profiles.push(await this.adapter.getProfile(profileUrl));
      } catch (error) {
        errors.push({ profileUrl, error: errorPayload(error) });
      }
    }
    return { profiles, errors };
  }

  getOperation(operationId: string): OperationRecord {
    const operation = this.operations.get(operationId);
    if (!operation) throw new ConnectorError("NOT_FOUND", `Operation '${operationId}' was not found.`);
    return operation;
  }

  async sendMessage(input: {
    operationId: string;
    profileUrl: string;
    text: string;
    commit: boolean;
  }): Promise<Record<string, unknown>> {
    const request = {
      profileUrl: normalizeLinkedInUrl(input.profileUrl),
      text: input.text,
    };
    if (!input.commit) {
      return {
        status: "preview",
        kind: "send_message",
        operationId: input.operationId,
        request,
        instruction: "Call again with commit=true to send.",
      };
    }
    this.assertActionsEnabled();

    const { record, isNew } = this.operations.reserve(input.operationId, "send_message", request);
    if (record.status === "succeeded") return { ...record.result, operationId: record.id, replayed: true };
    if (!isNew && ["executing", "unknown"].includes(record.status)) {
      if (await this.adapter.messageAlreadySent(request.profileUrl, request.text)) {
        const result = { sent: true, reconciled: true, profileUrl: request.profileUrl };
        this.operations.update(record.id, "succeeded", { result, error: null });
        return { ...result, operationId: record.id };
      }
      throw new ConnectorError(
        "ACTION_OUTCOME_UNKNOWN",
        "A previous attempt may have clicked Send, and the outcome cannot be proven. It will not be retried automatically.",
        { operationId: record.id },
      );
    }

    this.operations.update(record.id, "executing", { error: null });

    try {
      if (await this.adapter.messageAlreadySent(request.profileUrl, request.text)) {
        const result = { sent: false, alreadyPresent: true, profileUrl: request.profileUrl };
        this.operations.update(record.id, "succeeded", { result, error: null });
        return { ...result, operationId: record.id };
      }
    } catch (error) {
      const payload = errorPayload(error).error as Record<string, unknown>;
      this.operations.update(record.id, "failed", { error: payload });
      throw error;
    }

    return this.executeMutation(record.id, async () => this.adapter.sendMessage(request.profileUrl, request.text));
  }

  async sendConnection(input: {
    operationId: string;
    profileUrl: string;
    note?: string;
    commit: boolean;
  }): Promise<Record<string, unknown>> {
    const request: Record<string, unknown> = {
      profileUrl: normalizeLinkedInUrl(input.profileUrl),
      ...(input.note ? { note: input.note } : {}),
    };
    if (!input.commit) {
      return {
        status: "preview",
        kind: "send_connection",
        operationId: input.operationId,
        request,
        instruction: "Call again with commit=true to send.",
      };
    }
    this.assertActionsEnabled();

    const { record, isNew } = this.operations.reserve(input.operationId, "send_connection", request);
    if (record.status === "succeeded") return { ...record.result, operationId: record.id, replayed: true };
    const profileUrl = request.profileUrl as string;
    if (isNew) this.operations.update(record.id, "executing", { error: null });
    let state: "pending" | "connected" | "available";
    try {
      state = await this.adapter.connectionState(profileUrl);
    } catch (error) {
      if (isNew) {
        const payload = errorPayload(error).error as Record<string, unknown>;
        this.operations.update(record.id, "failed", { error: payload });
      }
      throw error;
    }
    if (state === "pending" || state === "connected") {
      const result = { sent: false, state, reconciled: !isNew, profileUrl };
      this.operations.update(record.id, "succeeded", { result, error: null });
      return { ...result, operationId: record.id };
    }
    if (!isNew && ["executing", "unknown"].includes(record.status)) {
      throw new ConnectorError(
        "ACTION_OUTCOME_UNKNOWN",
        "A previous attempt may have sent the invitation, and the outcome cannot be proven. It will not be retried automatically.",
        { operationId: record.id },
      );
    }

    return this.executeMutation(record.id, async () =>
      this.adapter.sendConnection(profileUrl, request.note as string | undefined),
    );
  }

  private assertActionsEnabled(): void {
    if (this.config.actionMode !== "execute") {
      throw new ConnectorError(
        "ACTION_DISABLED",
        "Mutating actions are in review mode. Set LINKEDIN_ACTION_MODE=execute and restart the connector.",
      );
    }
  }

  private async executeMutation(
    operationId: string,
    mutation: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    this.operations.update(operationId, "executing", { error: null });
    try {
      const result = await mutation();
      this.operations.update(operationId, "succeeded", { result, error: null });
      return { ...result, operationId };
    } catch (error) {
      const payload = errorPayload(error).error as Record<string, unknown>;
      this.operations.update(operationId, error instanceof ActionOutcomeUnknownError ? "unknown" : "failed", {
        error: payload,
      });
      throw error;
    }
  }
}
