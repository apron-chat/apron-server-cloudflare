import { describe, expect, it } from 'vitest';
import { MAX_USER_EXT_BYTES, SERVER_USER_EXT_KEYS, clientUserExt, recordedUser, userExtFits } from '../../src/content/user';

describe('users as records carry them, and their ext (§3.3, §4.13)', () => {
	it('drops the keys the server owns from a user\'s ext', () => {
		expect(SERVER_USER_EXT_KEYS).toEqual(['permissions']);
		expect(clientUserExt({ tz: 'UTC', permissions: { write: true } })).toEqual({ tz: 'UTC' });
		expect(clientUserExt({ permissions: { write: true } })).toBeUndefined();
		const kept = { tz: 'UTC' };
		expect(clientUserExt(kept)).toBe(kept);
		expect(clientUserExt(undefined)).toBeUndefined();
	});

	it.each([
		['no ext', undefined, true],
		['a small ext', { tz: 'UTC' }, true],
		['an ext of exactly the cap', { k: 'x'.repeat(MAX_USER_EXT_BYTES - 8) }, true],
		['an ext one byte past the cap', { k: 'x'.repeat(MAX_USER_EXT_BYTES - 7) }, false],
	])('fits %s: %s', (_name, ext, fits) => {
		expect(userExtFits(ext)).toBe(fits);
	});

	it('records a user with a name only when it has one', () => {
		expect(recordedUser('ada', 'Ada')).toEqual({ user_id: 'ada', name: 'Ada' });
		expect(recordedUser('ada', '')).toEqual({ user_id: 'ada' });
		expect(recordedUser('ada', null)).toEqual({ user_id: 'ada' });
	});
});
