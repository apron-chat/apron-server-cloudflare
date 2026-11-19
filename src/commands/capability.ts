/**
 * Capabilities: proof, carried as a value, that a command's sender passed
 * an authorization check. A privileged runtime method takes one as its
 * first parameter and asserts it first, so TypeScript refuses a call path
 * that never authorized, and the assertion refuses at run time a value
 * that did not come from here (a cast, `Object.create`, or a capability
 * whose command has finished).
 *
 * Only this module constructs them: each class's constructor demands a
 * module-private token, and its static block hands this module alone a
 * factory. Every one issued is remembered in a module-level WeakSet, which
 * the assertions check.
 */
import type { ProtocolError } from "../protocol";
import { auditField, type AdminAuditEvent, type AuditDetails, type AuditSink } from "./audit";

/** Who sent a command, as the connection's attachment has it (ConnectionAttachment fits). */
export interface CommandIdentity {
	readonly tier: string;
	readonly userId?: string;
	readonly roles?: readonly string[];
}

/** Whether the sender is a registered user holding `role` (§3.3); guests hold none. */
export function holdsRole(identity: CommandIdentity, role: string): boolean {
	return identity.tier === "registered" && (identity.roles ?? []).includes(role);
}

/** Whether the sender is an owner: a registered user who is not a bot, by the `bot` role. */
export function isOwner(identity: CommandIdentity): boolean {
	return identity.tier === "registered" && !holdsRole(identity, "bot");
}

/**
 * Whether the sender is an admin: an owner holding the `admin` role. The
 * `APRON_ADMIN_TOKEN` user (`admin`) is one by its stored role, which the
 * store never lets it lose; bots and guests never are.
 */
export function isAdmin(identity: CommandIdentity): boolean {
	return isOwner(identity) && holdsRole(identity, "admin");
}

/** The token each constructor demands; never exported, so nothing outside this module can pass it. */
const MINT: unique symbol = Symbol("capability mint");

/** Every AdminCapability authorizeAdmin issued, and those whose command has finished (settle). */
const issuedAdmin = new WeakSet<object>();
const settledAdmin = new WeakSet<object>();
/** Every RoleCapability authorizeRoles issued, with the roles it was checked against. */
const issuedRoles = new WeakMap<object, readonly string[]>();

let mintAdmin: (actor: string, command: string, at: number, sink: AuditSink) => AdminCapability;
let mintRoles: (actor: string, roles: readonly string[]) => RoleCapability;

/** Hands an event to the sink; a sink that throws never changes the command's outcome. */
function record(sink: AuditSink, event: AdminAuditEvent): void {
	try {
		sink.record(event);
	} catch { /* the command's outcome stands */ }
}

/**
 * Proof that `actor` was an admin when `command` was authorized, at `at`.
 * It authorizes the privileged methods until the dispatcher settles it
 * with the command's one audit event, and nothing after.
 */
export class AdminCapability {
	readonly actor: string;
	readonly command: string;
	readonly at: number;
	readonly #sink: AuditSink;

	static {
		mintAdmin = (actor, command, at, sink) => new AdminCapability(MINT, actor, command, at, sink);
	}

	private constructor(token: typeof MINT, actor: string, command: string, at: number, sink: AuditSink) {
		if (token !== MINT) throw new TypeError("An AdminCapability is issued by authorizeAdmin only");
		this.actor = actor;
		this.command = command;
		this.at = at;
		this.#sink = sink;
		issuedAdmin.add(this);
		Object.freeze(this);
	}

	/** Whether the command has finished and been audited, so this authorizes nothing more. */
	get settled(): boolean {
		return settledAdmin.has(this);
	}

	/**
	 * Records the command's audit event, `ok` or `failed`, and ends this
	 * capability. The dispatcher's alone (dispatchCommand), once per command;
	 * a second call records nothing.
	 */
	settle(outcome: "ok" | "failed", details: AuditDetails, reason?: string): void {
		if (settledAdmin.has(this)) return;
		settledAdmin.add(this);
		const target = auditField(details.target);
		const action = auditField(details.action);
		record(this.#sink, {
			event: "admin_action", actor: this.actor, command: this.command,
			...(target !== undefined ? { target } : {}), ...(action !== undefined ? { action } : {}),
			outcome, ...(reason !== undefined ? { reason } : {}), at: this.at,
		});
	}
}

/**
 * The one way to an AdminCapability: the sender must be an admin
 * (isAdmin). A refusal is recorded (`refused`) and thrown as `denied`, as
 * the command has always answered it; the dispatcher alone calls this.
 */
export function authorizeAdmin(identity: CommandIdentity, command: string, sink: AuditSink, now: number): AdminCapability {
	if (!isAdmin(identity)) {
		record(sink, { event: "admin_action", actor: identity.userId ?? "", command, outcome: "refused", reason: "denied", at: now });
		throw { name: "denied", message: `Only an admin can use /${command}` } satisfies ProtocolError;
	}
	return mintAdmin(identity.userId ?? "", command, now, sink);
}

/** Throws unless `cap` is an AdminCapability authorizeAdmin issued whose command has not finished. */
export function assertAdmin(cap: unknown): asserts cap is AdminCapability {
	if (typeof cap !== "object" || cap === null || !issuedAdmin.has(cap)) throw new TypeError("Not an AdminCapability that authorizeAdmin issued");
	if (settledAdmin.has(cap)) throw new TypeError("This AdminCapability's command has finished");
}

/**
 * Proof that `actor` held one of `roles` when a role-gated command
 * (`/emoji`, EMOJI_ROLES) was authorized. Those commands' store calls do
 * not check roles themselves, so this is what keeps them behind the check.
 */
export class RoleCapability {
	readonly actor: string;
	readonly roles: readonly string[];

	static {
		mintRoles = (actor, roles) => new RoleCapability(MINT, actor, roles);
	}

	private constructor(token: typeof MINT, actor: string, roles: readonly string[]) {
		if (token !== MINT) throw new TypeError("A RoleCapability is issued by authorizeRoles only");
		this.actor = actor;
		this.roles = roles;
		issuedRoles.set(this, roles);
		Object.freeze(this);
	}
}

/** The one way to a RoleCapability: the sender must hold one of `roles`, else `denied`, as the command has always answered it. */
export function authorizeRoles(identity: CommandIdentity, command: string, roles: readonly string[]): RoleCapability {
	if (!roles.some((role) => holdsRole(identity, role))) {
		throw { name: "denied", message: `/${command} needs one of the roles ${roles.join(", ")}` } satisfies ProtocolError;
	}
	return mintRoles(identity.userId ?? "", roles);
}

/**
 * Throws unless `cap` is a RoleCapability authorizeRoles issued for roles
 * that are all among `roles`, so its holder holds one of them.
 */
export function assertRoles(cap: unknown, roles: readonly string[]): asserts cap is RoleCapability {
	const checked = typeof cap === "object" && cap !== null ? issuedRoles.get(cap) : undefined;
	if (!checked) throw new TypeError("Not a RoleCapability that authorizeRoles issued");
	if (!checked.every((role) => roles.includes(role))) throw new TypeError(`This RoleCapability was not checked against ${roles.join(", ")}`);
}
