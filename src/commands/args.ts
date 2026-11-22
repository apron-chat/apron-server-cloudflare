/**
 * Parsers that turn a command's words into typed arguments. Each result is
 * branded, so a handler can take only a value that went through its
 * parser, and each failure throws the `invalid_params` error the command
 * has always answered with (or, for a count past its limit, `denied`).
 */
import type { ProtocolError } from "../protocol";
import { ADMIN_USER_ID, issuableShape } from "../user-ids";

declare const brand: unique symbol;
/** A `T` that went through the parser named `B`. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** A `user_id` as a command names it, a leading `@` (a mention, Appendix A.3) taken off. Not checked against any identity. */
export type UserIdArg = Brand<string, "UserIdArg">;
/** A `user_id` an admin may issue (`/invite-token`, `/rename`): well formed, not a guest's or bot's, and not `admin`. */
export type IssuableUserId = Brand<string, "IssuableUserId">;
/** A room ID as typed (`/history export`); the export says which it does not know. */
export type RoomIdArg = Brand<string, "RoomIdArg">;
/** A sign-up invite's count (`/invite-code`): 0, which revokes, to its limit. */
export type InviteUses = Brand<number, "InviteUses">;
/** A passkey's 1-based number in `/passkeys`' list, as typed (at most two digits). */
export type PasskeyNumber = Brand<number, "PasskeyNumber">;

/** The `invalid_params` error a command answers a malformed line with. */
export function usageError(message: string): ProtocolError {
	return { name: "invalid_params", message };
}

/** Throws the command's usage error unless it has exactly `count` arguments after its name. */
export function arity(words: readonly string[], count: number, usage: string): void {
	if (words.length !== count + 1) throw usageError(`Usage: ${usage}`);
}

/** A word with one leading `@` taken off, as a client's mention writes a `user_id`. */
export function stripMention(word: string): string {
	return word.replace(/^@/, "");
}

/** A `user_id` argument, its leading `@` taken off; it may be empty (the store then finds no such user). */
export function userIdArg(word: string): UserIdArg {
	return stripMention(word) as UserIdArg;
}

/**
 * The admin commands' one required argument (a `user_id`, a feature, a
 * count): the word, its leading `@` taken off as for a `user_id`, which
 * must leave something, else the usage error.
 */
export function requiredArg(word: string | undefined, usage: string): string {
	const value = word === undefined ? "" : stripMention(word);
	if (!value) throw usageError(`Usage: ${usage}`);
	return value;
}

/** requiredArg for a `user_id`. */
export function requiredUserId(word: string | undefined, usage: string): UserIdArg {
	return requiredArg(word, usage) as UserIdArg;
}

/** A `user_id` an admin may issue: `admin` is taken (it is no passkey user's to take), and the rest must be of issuableShape. */
export function issuableUserId(userId: string): IssuableUserId {
	if (userId === ADMIN_USER_ID) throw usageError(`The user_id ${userId} is taken`);
	if (!issuableShape(userId)) {
		throw usageError("A user_id is 1 to 64 letters, digits, _ or -, starting with a letter or digit, ending with a letter, digit or _, and not guest_ or bot_");
	}
	return userId as IssuableUserId;
}

/** Room IDs as typed, any number of them. */
export function roomIdArgs(words: readonly string[]): RoomIdArg[] {
	return words.map((word) => word as RoomIdArg);
}

/** One of `choices`, exactly as written, else the usage error listing them. */
export function oneOf<T extends string>(word: string, choices: readonly T[], usage: string): T {
	const chosen = choices.find((choice) => choice === word);
	if (chosen === undefined) throw usageError(usage);
	return chosen;
}

/**
 * `/invite-code`'s count: one to three digits, else `invalid_params` with
 * its usage and the range; more than `max` is a count limit, `denied` (§1.1).
 */
export function inviteUses(word: string, max: number, usage: string): InviteUses {
	const uses = /^\d{1,3}$/.test(word) ? Number(word) : -1;
	if (uses < 0) throw usageError(`Usage: ${usage}, 0 to ${max}`);
	if (uses > max) throw { name: "denied", message: `An invite signs up at most ${max} users` } satisfies ProtocolError;
	return uses as InviteUses;
}

/** A passkey's number in `/passkeys`' list: one or two digits, else the usage error given. */
export function passkeyNumber(word: string, usage: ProtocolError): PasskeyNumber {
	if (!/^\d{1,2}$/.test(word)) throw usage;
	return Number(word) as PasskeyNumber;
}
