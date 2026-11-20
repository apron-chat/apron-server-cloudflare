/*
 * What a content check answers: the value as kept, or why it is refused,
 * with the protocol's error code (§1.1: `invalid_params` for a malformed
 * value, `denied` for a count limit this server sets, `too_large` for a
 * size limit). Pure: the Store turns a refusal into a StoreError, an
 * import counts it as a rejected record.
 */

export type RefusalCode = "invalid_params" | "denied" | "too_large";

export interface Refusal {
	ok: false;
	code: RefusalCode;
	message: string;
}

export type Verdict<T> = { ok: true; value: T } | Refusal;

export function accept<T>(value: T): Verdict<T> {
	return { ok: true, value };
}

export function refuse(code: RefusalCode, message: string): Refusal {
	return { ok: false, code, message };
}

/** Whether a value is a plain JSON object (not an array or null). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A value's UTF-8 length in bytes. */
export function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

/** A deep copy of a JSON value. */
export function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/** A string within `maxBytes` of UTF-8, named `field` in the refusal. */
export function boundedText(value: unknown, field: string, maxBytes: number): Verdict<string> {
	if (typeof value !== "string") return refuse("invalid_params", `${field} must be a string`);
	if (utf8Bytes(value) > maxBytes) return refuse("too_large", `${field} is too large`);
	return accept(value);
}
