/**
 * A hook for an audit trail of admin commands, not yet kept anywhere: the
 * dispatcher hands an AuditSink one `admin_action` event per admin command
 * that reached authorization, whether it was refused there, failed, or
 * ran. An event names who acted, the command, what it acted on and how it
 * ended; never message content, a token, a secret, or an error's message,
 * which may quote what the user typed. The runtime's sink records nothing
 * (noAuditSink); a later one could post each event as a message in a
 * private room only admins can read.
 */

/** How an admin command ended: ran, refused at authorization, or failed after it (a usage error included). */
export type AdminOutcome = "ok" | "refused" | "failed";

/** One admin command's audit event, as a log line carries it. */
export interface AdminAuditEvent {
	event: "admin_action";
	/** The `user_id` of the connection that sent the command. */
	actor: string;
	/** The command's name, without its slash. */
	command: string;
	/** What it acted on: a `user_id`, a feature, a backup key or room IDs; absent when it names none or did not parse. */
	target?: string;
	/** Which of the command's forms ran, such as `remove`, `title` or `export`; absent for a command with one form. */
	action?: string;
	outcome: AdminOutcome;
	/** Why it was refused or failed: an error's name (`denied`, `invalid_params`, ...), never its message. */
	reason?: string;
	/** When the command was authorized, in epoch milliseconds. */
	at: number;
}

/** Where admin audit events go. The runtime holds one, which tests replace to capture events. */
export interface AuditSink {
	record(event: AdminAuditEvent): void;
}

/** What a command's arguments tell the audit trail (CommandSpec.audit). */
export interface AuditDetails {
	target?: string;
	action?: string;
}

/** The longest `target` or `action` an event keeps: a command's arguments are bounded by the frame, not by this. */
const MAX_AUDIT_FIELD_CHARS = 200;

/** Cuts a `target` or `action` to MAX_AUDIT_FIELD_CHARS, so one command cannot write a long log line. */
export function auditField(value: string | undefined): string | undefined {
	return value === undefined || value === "" ? undefined : value.slice(0, MAX_AUDIT_FIELD_CHARS);
}

/** The runtime's sink for now: events are made, and kept nowhere. */
export const noAuditSink: AuditSink = {
	record() {},
};
