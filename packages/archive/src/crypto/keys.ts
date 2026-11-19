/*
 * Backup keys by secret name, from an environment object (a Worker's env,
 * process.env): the names a server's config lists are the only ones read,
 * and each is derived (core.ts deriveBackupKey) once, when first asked for.
 */

import { type BackupKey, deriveBackupKey } from "./core.ts";
import type { BackupKeys } from "./stream.ts";

/** The backup keys among `env`'s values, by name. A listed name that is unset or blank reads as absent. */
export function resolveKeys(env: object, names: readonly string[]): BackupKeys {
	const values = env as Record<string, unknown>;
	const listed = [...names];
	const derived = new Map<string, Promise<BackupKey>>();
	return {
		names: listed,
		lookup: async (name) => {
			if (!listed.includes(name)) return undefined;
			const value = values[name];
			if (typeof value !== "string" || value.trim() === "") return undefined;
			let key = derived.get(name);
			if (!key) {
				key = deriveBackupKey(value, name);
				derived.set(name, key);
			}
			return key;
		},
	};
}
