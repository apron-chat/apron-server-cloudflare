/*
 * This server's user ID rules for archives it imports (PLAN §10.4): which
 * archive user IDs may hold an account here as themselves, and where one
 * that may not starts from. @apron/archive's planImport takes them as its
 * UserIdRules; Store.restoreUsers checks placeholders with them again.
 */

import type { UserIdRules } from "@apron/archive";

/**
 * The registered user `APRON_ADMIN_TOKEN` signs in as, always an admin. It
 * never holds a passkey, so deleting the token turns it off completely.
 */
export const ADMIN_USER_ID = "admin";

/**
 * Whether an archive's `user_id` may stand here as itself, matched or as a
 * placeholder account: the shape an admin may issue (`/invite-token`,
 * `/rename`), and not a guest's, an owner's bot's, a server notice's (`~…`)
 * or the admin's.
 */
export function restorableUserId(userId: unknown): userId is string {
	return typeof userId === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?$/.test(userId) && !/^(guest|bot)(_|$)/i.test(userId) && userId.toLowerCase() !== ADMIN_USER_ID;
}

/**
 * The placeholder ID an archive user whose ID cannot stand here starts from
 * (restorableUserId): `imported-` and the ID's letters, digits, `_` and
 * `-`, short enough that a `-<n>` suffix still fits.
 */
export function placeholderBase(userId: string): string {
	const cleaned = userId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[-_]+/, "").slice(0, 40).replace(/[-_]+$/, "");
	return `imported-${cleaned || "user"}`;
}

/** The rules as planImport takes them: the admin may be matched (its account exists), never made. */
export const USER_ID_RULES: UserIdRules = {
	restorable: restorableUserId,
	matchable: (userId) => restorableUserId(userId) || userId === ADMIN_USER_ID,
	placeholderBase,
};
