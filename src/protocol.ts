import { DEFAULT_LIMITS } from "./budget";

export const ERROR_CODES = Object.freeze({
	parse_error: -32700,
	invalid_request: -32600,
	unsupported: -32601,
	invalid_params: -32602,
	internal_error: -32603,
	denied: -32001,
	retry_after: -32002,
	too_large: -32003,
} as const);

export type ErrorName = keyof typeof ERROR_CODES;

export interface ProtocolError {
	name: ErrorName;
	message: string;
	data?: Record<string, unknown>;
}

export interface RequestFrame {
	method: string;
	params: Record<string, unknown>;
	id?: string;
}

export interface ParsedFrame {
	request: RequestFrame;
	bytes: number;
}

export class FrameError extends Error {
	readonly protocol: ProtocolError;
	readonly closeCode?: number;
	readonly id: string | null;
	readonly notification: boolean;

	constructor(protocol: ProtocolError, options: { id?: string | null; notification?: boolean; closeCode?: number } = {}) {
		super(protocol.message);
		this.name = "FrameError";
		this.protocol = protocol;
		this.id = options.id ?? null;
		this.notification = options.notification ?? false;
		this.closeCode = options.closeCode;
	}
}

export function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function walkJson(value: unknown, state: { nodes: number; maxDepth: number; maxNodes: number }): void {
	// Use an explicit stack: a hostile frame must never be able to exhaust the
	// JavaScript call stack before the configured depth/node gate runs.
	const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
	while (pending.length) {
		const current = pending.pop()!;
		state.nodes += 1;
		if (state.nodes > state.maxNodes) throw new FrameError({ name: "too_large", message: "JSON structure is too large" });
		const container = Array.isArray(current.value) || isObject(current.value);
		if (container) {
			state.maxDepth = Math.max(state.maxDepth, current.depth);
			if (current.depth > 8_192) throw new FrameError({ name: "too_large", message: "JSON structure is too deep" });
			if (Array.isArray(current.value)) {
				for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
			} else if (isObject(current.value)) {
				for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 });
			}
		}
	}
}

export interface ParseOptions {
	maxFrameBytes: number;
	maxJsonDepth: number;
	maxJsonNodes: number;
	maxRequestIdBytes: number;
}

export const DEFAULT_PARSE_OPTIONS: ParseOptions = {
	maxFrameBytes: DEFAULT_LIMITS.maxFrameBytes,
	maxJsonDepth: DEFAULT_LIMITS.maxJsonDepth,
	maxJsonNodes: DEFAULT_LIMITS.maxJsonNodes,
	maxRequestIdBytes: DEFAULT_LIMITS.maxRequestIdBytes,
};

/**
 * Methods clients send as notifications, without an `id` (the table in
 * §1.1). By this server's policy, not the protocol's, one sent with an `id`
 * anyway is handled as the notification and gets no reply, not even an
 * error for invalid params: answering it would make a notification look
 * like a request. The liveness ping is answered with `pong`, a
 * notification, not a reply. A client's `status` is a request (§1.1, §4.5),
 * not one of these.
 */
export const NOTIFICATION_METHODS: ReadonlySet<string> = new Set(["ping", "activity"]);

/**
 * Methods clients send as requests, with an `id` (the table in §1.1). One
 * sent without an `id` is ignored, as §1.1 lets a server: it changes
 * nothing and gets no reply, so a client can never believe an unanswered
 * change was applied.
 */
export const REQUEST_METHODS: ReadonlySet<string> = new Set([
	"auth", "me", "message", "command", "history", "room_list", "room_join", "room_leave",
	"room_set", "reactions", "status", "push_register", "push_unregister",
]);

/** Whether `method` is one clients send only as a notification (§1.1). */
export function notificationOnly(method: unknown): boolean {
	return typeof method === "string" && NOTIFICATION_METHODS.has(method);
}

/** Whether a frame gets no reply: it has no `id`, or its method is only a notification (NOTIFICATION_METHODS). */
export function isNotification(method: unknown, id: string | undefined): boolean {
	return id === undefined || notificationOnly(method);
}

/** Parse one application frame after applying the byte gate. */
export function parseFrame(data: string | ArrayBuffer | ArrayBufferView, options: ParseOptions = DEFAULT_PARSE_OPTIONS): ParsedFrame {
	if (typeof data !== "string") {
		throw new FrameError({ name: "invalid_request", message: "Binary application frames are not supported" }, { closeCode: 1003 });
	}
	const bytes = utf8Bytes(data);
	if (bytes > options.maxFrameBytes) {
		// Do not parse a potentially hostile oversized payload to discover an ID.
		throw new FrameError({ name: "too_large", message: "Frame exceeds the maximum size" }, { closeCode: 1009 });
	}
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		throw new FrameError({ name: "parse_error", message: "Parse error" });
	}
	const state = { nodes: 0, maxDepth: 0, maxNodes: options.maxJsonNodes };
	if (!isObject(value)) throw new FrameError({ name: "invalid_request", message: "Request must be an object" });
	let id: string | undefined;
	if (Object.hasOwn(value, "id")) {
		if (typeof value.id !== "string" || utf8Bytes(value.id) > options.maxRequestIdBytes) {
			// A notification-only method is never answered, whatever its `id` (NOTIFICATION_METHODS).
			throw new FrameError({ name: "invalid_request", message: "Request id must be a bounded string" }, { notification: notificationOnly(value.method) });
		}
		id = value.id;
	}
	// Decided from the method, which is known before any params check, so no
	// error below answers a notification-only method sent with an `id` (NOTIFICATION_METHODS).
	const notification = isNotification(value.method, id);
	const failure = { id: id ?? null, notification };
	// An invalid envelope is answered, even without an `id`, unless its method is only a notification.
	const envelope = { id: id ?? null, notification: notificationOnly(value.method) };
	if (typeof value.method !== "string" || value.method.length === 0) throw new FrameError({ name: "invalid_request", message: "Method must be a non-empty string" }, envelope);
	try {
		walkJson(value, state);
	} catch (error) {
		if (error instanceof FrameError) throw new FrameError(error.protocol, failure);
		throw new FrameError({ name: "too_large", message: "JSON structure is too large" }, failure);
	}
	let params: Record<string, unknown> = {};
	if (Object.hasOwn(value, "params")) {
		if (!isObject(value.params)) throw new FrameError({ name: "invalid_params", message: "Params must be an object" }, failure);
		params = value.params;
	}
	// The parsed root is already bounded. Re-check the configured depth here so
	// tests and callers can use a lower policy than the guard's hard ceiling.
	const configuredDepth = state.maxDepth;
	if (configuredDepth > options.maxJsonDepth) throw new FrameError({ name: "too_large", message: "JSON nesting is too deep" }, failure);
	return { request: { method: value.method, params, ...(id === undefined ? {} : { id }) }, bytes };
}

export function protocolReply(id: string, result: unknown): Record<string, unknown> {
	return { id, result };
}

/** Errors not tied to a request (no known `id`) omit `id` entirely. */
export function protocolError(id: string | null | undefined, error: ProtocolError): Record<string, unknown> {
	return {
		...(id == null ? {} : { id }),
		error: { code: ERROR_CODES[error.name], message: error.message, ...(error.data ? { data: error.data } : {}) },
	};
}

/** `data.retry_after` is whole seconds, rounded up, at least one. */
export function retryAfterSeconds(ms: number): number {
	return Math.max(1, Math.ceil(ms / 1_000));
}

export function errorFromUnknown(error: unknown): ProtocolError {
	if (error instanceof FrameError) return error.protocol;
	if (error && typeof error === "object" && "name" in error && typeof error.name === "string" && Object.hasOwn(ERROR_CODES, error.name)) {
		const typed = error as { name: ErrorName; message?: unknown; data?: unknown };
		return { name: typed.name, message: typeof typed.message === "string" ? typed.message : "Request failed", data: isObject(typed.data) ? typed.data : undefined };
	}
	return { name: "internal_error", message: "Request failed" };
}

export function jsonString(value: unknown): string {
	const result = JSON.stringify(value);
	if (result === undefined) throw new Error("cannot serialize protocol value");
	return result;
}

/** Stable recursive representation used for request deduplication. */
export function canonicalize(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (isObject(value)) {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
	}
	throw new TypeError("unsupported JSON value");
}

export async function digestRequest(method: string, params: Record<string, unknown>): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalize({ method, params }));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function requiredString(params: Record<string, unknown>, name: string): string {
	const value = params[name];
	if (typeof value !== "string" || value.length === 0) throw { name: "invalid_params", message: `${name} must be a non-empty string` } satisfies ProtocolError;
	return value;
}

export function optionalString(params: Record<string, unknown>, name: string): string | undefined {
	const value = params[name];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw { name: "invalid_params", message: `${name} must be a string` } satisfies ProtocolError;
	return value;
}

export function objectParam(params: Record<string, unknown>, name: string, required = true): Record<string, unknown> | undefined {
	const value = params[name];
	if (value === undefined && !required) return undefined;
	if (!isObject(value)) throw { name: "invalid_params", message: `${name} must be an object` } satisfies ProtocolError;
	return value;
}

export function positiveIntParam(params: Record<string, unknown>, name: string): number | undefined {
	const value = params[name];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw { name: "invalid_params", message: `${name} must be a positive integer` } satisfies ProtocolError;
	return value;
}
