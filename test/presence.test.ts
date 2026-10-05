import { describe, expect, it } from 'vitest';
import { deriveStatus, isStatus, type StatusInputs } from '../src/presence';

const none: StatusInputs = { invisible: false, muted: false, connected: false, attended: false, push: false };
const status = (inputs: Partial<StatusInputs>, forSelf = false) => deriveStatus({ ...none, ...inputs }, forSelf);

describe('user status (§4.11): the first rule that applies', () => {
	it('1. invisible: offline to others, whatever else holds; `you` ignores it', () => {
		for (const inputs of [
			{ connected: true, attended: true },
			{ connected: true, muted: true },
			{ connected: true },
			{ push: true },
			{},
		]) {
			expect(status({ ...inputs, invisible: true })).toBe('offline');
			expect(status({ ...inputs, invisible: true }, true)).toBe(status(inputs));
		}
	});

	it('2. dnd: the unscoped mute is set and the user has a connection, attended or not', () => {
		expect(status({ muted: true, connected: true, attended: true })).toBe('dnd');
		expect(status({ muted: true, connected: true })).toBe('dnd');
		expect(status({ muted: true, connected: true, push: true })).toBe('dnd');
		expect(status({ muted: true, connected: true }, true)).toBe('dnd');
	});

	it('2. a muted user without a connection is not dnd but offline, push or not', () => {
		expect(status({ muted: true })).toBe('offline');
		expect(status({ muted: true, push: true })).toBe('offline');
	});

	it('3. online: a connection is attended', () => {
		expect(status({ connected: true, attended: true })).toBe('online');
		expect(status({ connected: true, attended: true, push: true })).toBe('online');
	});

	it('4. idle: a connection is idle, or not muted with a registration that wakes for messages', () => {
		expect(status({ connected: true })).toBe('idle');
		expect(status({ connected: true, push: true })).toBe('idle');
		expect(status({ push: true })).toBe('idle');
	});

	it('5. offline: no connection and no waking registration', () => {
		expect(status({})).toBe('offline');
		// An attended flag means nothing without a connection.
		expect(status({ attended: true })).toBe('offline');
	});

	it('knows the four statuses and nothing else', () => {
		for (const value of ['online', 'idle', 'dnd', 'offline']) expect(isStatus(value)).toBe(true);
		for (const value of ['away', '', undefined, 1, null]) expect(isStatus(value)).toBe(false);
	});
});
