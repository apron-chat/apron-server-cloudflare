// A user's `status` (protocol §4.11), derived from what the server knows
// about them. Pure: the Durable Object gathers the inputs from connection
// attachments and, for users without a connection, from storage.

export type Status = "online" | "idle" | "dnd" | "offline";

export const STATUSES: readonly Status[] = ["online", "idle", "dnd", "offline"];

export function isStatus(value: unknown): value is Status {
	return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

export interface StatusInputs {
	/** The user is `invisible`. */
	invisible: boolean;
	/** The unscoped `mute` is set (and not yet run out). */
	muted: boolean;
	/** The user has a connection (authenticated, open, not stale). */
	connected: boolean;
	/** One of the user's connections is attended. */
	attended: boolean;
	/**
	 * The user has a push registration that wakes for messages (§4.7). Only
	 * decides a user without a connection; unknown counts as none.
	 */
	push: boolean;
}

/**
 * The first of these that applies (§4.11), for others or, with `forSelf`,
 * for the user's own `you`, which ignores `invisible`:
 *
 * 1. `offline`: the user is invisible;
 * 2. `dnd`: the unscoped mute is set and the user has a connection;
 * 3. `online`: a connection is attended;
 * 4. `idle`: a connection is idle, or the mute is not set and the user has
 *    a push registration that wakes for messages;
 * 5. `offline`.
 */
export function deriveStatus(inputs: StatusInputs, forSelf = false): Status {
	if (inputs.invisible && !forSelf) return "offline";
	if (inputs.muted && inputs.connected) return "dnd";
	if (inputs.connected && inputs.attended) return "online";
	// Every connection of a connected user that is not attended is idle.
	if (inputs.connected || (!inputs.muted && inputs.push)) return "idle";
	return "offline";
}
