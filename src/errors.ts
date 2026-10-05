export type ConnectorErrorCode =
  | "AUTH_REQUIRED"
  | "CHALLENGE_REQUIRED"
  | "FILTER_UNAVAILABLE"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "UI_CHANGED"
  | "ACTION_DISABLED"
  | "ACTION_CONFLICT"
  | "ACTION_OUTCOME_UNKNOWN"
  | "LIMIT_REACHED"
  | "BROWSER_ERROR";

export class ConnectorError extends Error {
  constructor(
    public readonly code: ConnectorErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export class ActionOutcomeUnknownError extends ConnectorError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("ACTION_OUTCOME_UNKNOWN", message, details);
    this.name = "ActionOutcomeUnknownError";
  }
}

export function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof ConnectorError) {
    return {
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: "BROWSER_ERROR", message } };
}
