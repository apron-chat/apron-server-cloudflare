// A user's `status` (protocol §4.5): the value they choose with `me`, and
// what others see of it. Pure: the Durable Object gathers the inputs from
// connection attachments, and for users without a connection from storage.

/** The `status` values a user may choose with `me` (§4.5): `online` is the default, `""` none. */
export type StatusChoice = "online" | "" | "dnd" | "invisible";

/** The `status` others see (§4.5). */
export type Status = "online" | "idle" | "dnd" | "offline" | "";

export const STATUS_CHOICES: readonly StatusChoice[] = ["online", "", "dnd", "invisible"];
/** The optional choices (§4.5), listed in `server.status`; `online` and `""` are always accepted and never listed. */
export const OPTIONAL_STATUS_CHOICES: readonly StatusChoice[] = ["dnd", "invisible"];
export const STATUSES: readonly Status[] = ["online", "idle", "dnd", "offline", ""];

export function isStatusChoice(value: unknown): value is StatusChoice {
	return typeof value === "string" && (STATUS_CHOICES as readonly string[]).includes(value);
}

export function isStatus(value: unknown): value is Status {
	return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

/**
 * The choice a `me` `status` string makes: itself when this server supports
 * it, else `""`, which servers set for a value they don't support (§4.5).
 */
export function statusChoice(value: string): StatusChoice {
	return isStatusChoice(value) ? value : "";
}

interface StatusInputs {
	/** What the user chose with `me`. */
	choice: StatusChoice;
	/** The user has a connection (authenticated, open, not stale). */
	connected: boolean;
	/** One of the user's connections is attended. */
	attended: boolean;
}

/**
 * What others see of a user (§4.5):
 *
 * - `""` (none) whatever their connections, so it never tells whether they
 *   are connected;
 * - `invisible`: `offline`;
 * - `dnd`: `dnd` while they have a connection, else `offline`;
 * - `online`: `online` when a connection is attended, `idle` when connected
 *   with none attended, `offline` with no connection.
 */
export function shownStatus(inputs: StatusInputs): Status {
	if (inputs.choice === "") return "";
	if (inputs.choice === "invisible" || !inputs.connected) return "offline";
	if (inputs.choice === "dnd") return "dnd";
	return inputs.attended ? "online" : "idle";
}

/** How present each shown status says a user is; `""` tells nothing, so it is left out. */
const PRESENCE_RANK: Readonly<Record<Exclude<Status, "">, number>> = { offline: 0, idle: 1, online: 2, dnd: 2 };

/**
 * Whether a change of what others see, `from` what they were told `to` what
 * holds now, shows the user more present: `offline` to `idle`, `online` or
 * `dnd`, or `idle` to `online` (or `dnd`, which only `me` makes, at once
 * anyway). Such a change is announced at once rather than coalesced
 * (§4.5.2 lets a server delay some changes and not others): coming back is
 * what others want to see. At most two come in a row (`offline`, `idle`,
 * `online`) between changes the other way, which are coalesced, so a
 * user's connections cause at most three announcements a minute.
 */
export function showsMorePresent(from: Status, to: Status): boolean {
	if (from === "" || to === "") return false;
	return PRESENCE_RANK[to] > PRESENCE_RANK[from];
}
