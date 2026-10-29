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
  /** Extra error `data` keys, such as `reason`, and `ext.limits` (limitData). */
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

/**
 * What a `retry_after`'s limit holds back (extension `ext:limits`,
 * EXTENSIONS.md): `read`, the refused `history` or `room_list` only;
 * `write`, `message`, `reactions`, `room_join`, `room_leave` and
 * `room_set`; `upload`, the `message` and `command` requests that carry new
 * `upload` embeds. A refusal names a category only on a request its row
 * lists.
 */
export type LimitCategory = "read" | "write" | "upload";

/** Error `data` naming a limit's category, as `ext.limits`. */
export function limitData(category: LimitCategory): { ext: { limits: LimitCategory } } {
  return { ext: { limits: category } };
}
