import { describe, expect, it } from 'vitest';
import { STATUSES, STATUS_CHOICES, isStatus, isStatusChoice, shownStatus, statusChoice, type StatusChoice } from '../src/presence';

const seen = (choice: StatusChoice, connected: boolean, attended = false) => shownStatus({ choice, connected, attended });

describe('user status (§4.11): what others see of the status a user chose', () => {
	it('online: online when a connection is attended, idle when connected with none attended, offline without one', () => {
		expect(seen('online', true, true)).toBe('online');
		expect(seen('online', true, false)).toBe('idle');
		expect(seen('online', false)).toBe('offline');
	});

	it('"" (none): none, connected or not, so it never tells', () => {
		expect(seen('', true, true)).toBe('');
		expect(seen('', true, false)).toBe('');
		expect(seen('', false)).toBe('');
	});

	it('dnd: dnd while connected, attended or not, else offline', () => {
		expect(seen('dnd', true, true)).toBe('dnd');
		expect(seen('dnd', true, false)).toBe('dnd');
		expect(seen('dnd', false)).toBe('offline');
	});

	it('invisible: offline, whatever else holds', () => {
		expect(seen('invisible', true, true)).toBe('offline');
		expect(seen('invisible', true, false)).toBe('offline');
		expect(seen('invisible', false)).toBe('offline');
	});

	it('takes each supported choice as is, and anything else as "" (none)', () => {
		for (const choice of STATUS_CHOICES) expect(statusChoice(choice)).toBe(choice);
		for (const other of ['idle', 'offline', 'away', 'ONLINE', 'busy', ' online']) expect(statusChoice(other)).toBe('');
	});

	it('knows the four choices and five shown statuses, and nothing else', () => {
		expect([...STATUS_CHOICES].sort()).toEqual(['', 'dnd', 'invisible', 'online']);
		expect([...STATUSES].sort()).toEqual(['', 'dnd', 'idle', 'offline', 'online']);
		expect(isStatusChoice('idle')).toBe(false);
		expect(isStatus('invisible')).toBe(false);
		expect(isStatus(undefined)).toBe(false);
	});
});
