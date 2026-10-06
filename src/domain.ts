/** The durable/runtime boundary shared by the WebSocket server and SQLite store. */

export interface Identity {
	user_id: string;
	name?: string;
	/** Internal quota tier. The wire name of the `anonymous` tier is `guest`. */
	tier?: "anonymous" | "registered";
}

export interface StoredCredential {
	credentialId: string;
	userId: string;
	publicKey: string;
	counter: number;
	deviceType?: string;
	backedUp?: boolean;
	transports?: string[];
}

export interface StoredIdentity {
	userId: string;
	name: string;
	userHandle: string;
	credentialCount: number;
	/** Rooms the identity has joined (protocol §4.3.2), kept across connections. */
	rooms: string[];
	/** The identity's avatar while it lasts (protocol §4.8.6). */
	avatar?: string;
	/** The identity's roles (protocol §3.3), kept in its row: `admin`, `bot`, or labels. */
	roles: string[];
	/** The identity's `ext` (protocol §4.12), kept in its row; absent when empty. */
	ext?: Record<string, unknown>;
}
