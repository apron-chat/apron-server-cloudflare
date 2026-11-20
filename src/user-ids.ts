/*
 * This server's user ID rules for archives it imports: which
 * archive user IDs may hold an account here as themselves, and where one
 * that may not starts from. @apron/archive's planImport takes them as its
 * UserIdRules; Store.restoreUsers checks placeholders with them again.
 */

import { type UserIdRules, defaultUserIdRules } from "@apron/archive";

/**
 * The registered user `APRON_ADMIN_TOKEN` signs in as, always an admin. It
 * never holds a passkey, so deleting the token turns it off completely.
 */
export const ADMIN_USER_ID = "admin";

/**
 * The shape of a `user_id` an admin may issue (`/invite-token`, `/rename`):
 * 1 to 64 letters, digits, `_` or `-`, starting with a letter or digit and
 * ending with a letter, digit or `_`, so that `@` and the whole ID make a
 * mention in text (Appendix A.3), and not a guest's or bot's.
 */
export function issuableShape(userId: string): boolean {
	return /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?$/.test(userId) && !/^(guest|bot)(_|$)/i.test(userId);
}

/**
 * Whether an archive's `user_id` may stand here as itself, matched or as a
 * placeholder account: the shape an admin may issue (issuableShape), and
 * not a server notice's (`~…`) or the admin's.
 */
export function restorableUserId(userId: unknown): userId is string {
	return typeof userId === "string" && issuableShape(userId) && userId.toLowerCase() !== ADMIN_USER_ID;
}

/**
 * The rules as planImport takes them: the admin may be matched (its account
 * exists), never made. An ID that cannot stand here starts from
 * `imported-` and its letters, digits, `_` and `-` (the library's default).
 */
export const USER_ID_RULES: UserIdRules = {
	restorable: restorableUserId,
	matchable: (userId) => restorableUserId(userId) || userId === ADMIN_USER_ID,
	placeholderBase: defaultUserIdRules.placeholderBase,
};
