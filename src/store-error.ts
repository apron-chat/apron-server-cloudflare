/** Errors the store raises, mapped to protocol errors by the socket layer. */

export type ErrorCode =
  | "parse_error"
  | "invalid_request"
  | "unsupported"
  | "invalid_params"
  | "internal_error"
  | "denied"
  | "retry_after"
  | "too_large";

export class StoreError extends Error {
  readonly code: ErrorCode;
  /** Delay the socket layer reports as `data.retry_after`, in whole seconds. */
  readonly retryAfterMs?: number;
  /** Extra error `data` keys, such as `reason`. */
  readonly data?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryAfterMs?: number; data?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
    this.data = options.data;
  }
}
