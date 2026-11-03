import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';

type Runtime = {
	pendingWakes: Set<{ message: unknown; reasons: Map<string, number> }>;
	statusChanges: { take(key: string, now: number): boolean; retry(key: string, now: number): number | undefined };
	announcedAt: Map<string, number>;
	departed: Set<string>;
	moveUserState(from: string, to: string): void;
};

it('moves every piece of a renamed user\'s state on the object to the new user_id', async () => {
	await runInDurableObject(env.DEMO.getByName(`rename-state-${crypto.randomUUID()}`), (instance) => {
		const runtime = instance as unknown as Runtime;
		const now = Date.now();
		const wake = { message: {}, reasons: new Map([['old_id', 1], ['other', 2]]) };
		runtime.pendingWakes.add(wake);
		// Up to the per-user limit of status changes this minute.
		while (runtime.statusChanges.take('old_id', now));
		runtime.announcedAt.set('old_id', now - 1_000);
		runtime.departed.add('old_id');
		runtime.moveUserState('old_id', 'new_id');
		expect([...wake.reasons]).toEqual([['other', 2], ['new_id', 1]]);
		// The limit is not reset by the rename.
		expect(runtime.statusChanges.retry('new_id', now)).toBeGreaterThan(0);
		expect(runtime.statusChanges.retry('old_id', now)).toBeUndefined();
		expect(runtime.announcedAt.has('old_id')).toBe(false);
		expect(runtime.announcedAt.get('new_id')).toBe(now - 1_000);
		expect([...runtime.departed]).toEqual(['new_id']);
		runtime.pendingWakes.delete(wake);
	});
});
