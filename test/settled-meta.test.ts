import { describe, expect, it } from 'vitest';
import { SettledMeta } from '../src/settled-meta';

describe('SettledMeta', () => {
	it('reads once, writes only changes, and keeps a failed write for the next flush', () => {
		const stored = new Map<string, string>([['k', 'a']]);
		let reads = 0;
		const read = (key: string) => { reads++; return stored.get(key) ?? ''; };
		const meta = new SettledMeta('k');
		expect(meta.value(read)).toBe('a');
		expect(meta.value(read)).toBe('a');
		expect(reads).toBe(1);
		expect(meta.flush(() => { throw new Error('no write expected'); })).toBe(true);

		meta.set('b');
		expect(meta.dirty).toBe(true);
		expect(meta.flush(() => { throw new Error('storage down'); })).toBe(false);
		expect(meta.dirty).toBe(true);
		expect(meta.persisted).toBe('a');
		expect(meta.flush((key, value) => { stored.set(key, value); })).toBe(true);
		expect(stored.get('k')).toBe('b');
		expect(meta.dirty).toBe(false);

		meta.forget();
		stored.set('k', 'c');
		expect(meta.value(read)).toBe('c');
		expect(reads).toBe(2);
	});
});
