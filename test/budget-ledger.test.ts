import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BUDGET_COLUMNS, BudgetLedger, type LedgerLimits, type RawBudgetRow } from '../src/budget-ledger';
import { StoreError } from '../src/store-error';

const limits: LedgerLimits = {
	sqlReadsPerDay: 1_000,
	sqlWritesPerDay: 1_000,
	foregroundReadsPerDay: 800,
	foregroundWritesPerDay: 800,
	maintenanceReadsPerDay: 200,
	maintenanceWritesPerDay: 200,
	historyRequestsPerDay: 2,
};

/** A stand-in for the store's metered SQL over one in-memory table of day rows. */
function host() {
	const table = new Map<string, RawBudgetRow>();
	const statements: string[] = [];
	const state = { unsafe: false, clock: 0, failUpdates: false, inTransaction: false };
	const ledgerHost = {
		exec(query: string, ...bindings: unknown[]) {
			statements.push(query);
			const day = String(bindings[bindings.length - 1] ?? bindings[0]);
			if (query.startsWith('INSERT')) {
				if (!table.has(String(bindings[0]))) table.set(String(bindings[0]), { day: String(bindings[0]), ...Object.fromEntries(BUDGET_COLUMNS.map((column) => [column, 0])) } as RawBudgetRow);
				return { rowsWritten: 1 };
			}
			if (query.startsWith('UPDATE')) {
				if (state.failUpdates) throw new Error('storage failure');
				const row = table.get(day);
				if (!row) return { rowsWritten: 0 };
				const columns = [...query.matchAll(/(\w+) = \1 \+ \?/g)].map((match) => match[1] as keyof RawBudgetRow);
				columns.forEach((column, index) => { (row[column] as number) += bindings[index] as number; });
				return { rowsWritten: 1 };
			}
			return { rowsWritten: 0 };
		},
		rows<T>(query: string, day: unknown): T[] {
			statements.push(query);
			const row = table.get(String(day));
			return (row ? [{ ...row }] : []) as T[];
		},
		advanceClock(now: number) { state.clock = now; },
		clock() { return state.clock; },
		inTransaction() { return state.inTransaction; },
		markUnsafe() { state.unsafe = true; },
	};
	return { ledgerHost, table, statements, state };
}

const noon = Date.parse('2026-09-21T12:00:00Z');

describe('budget ledger', () => {
	it('counts history pages against their own ceiling, and a refused page gives its count back in the refund', () => {
		const { ledgerHost, table, statements } = host();
		const ledger = new BudgetLedger(ledgerHost, limits);
		ledger.start('2026-09-21');
		const first = ledger.reserve({ reads: 10, writes: 10, history: 1 }, noon, noon, false, false);
		ledger.refund(first, 1, 1);
		expect(table.get('2026-09-21')?.history_reserved).toBe(1);
		const updates = statements.length;
		const refused = ledger.reserve({ reads: 10, writes: 10, history: 1 }, noon, noon, false, false);
		ledger.refund(refused, 1, 1, { history: 1 });
		// The reservation, its refund and the give-back are one update, and cancel out.
		expect(statements.length).toBe(updates + 1);
		expect(table.get('2026-09-21')?.history_reserved).toBe(1);
		const second = ledger.reserve({ reads: 10, writes: 10, history: 1 }, noon, noon, false, false);
		ledger.refund(second, 1, 1);
		const before = statements.length;
		let error: unknown;
		try { ledger.reserve({ reads: 10, writes: 10, history: 1 }, noon, noon, false, false); } catch (caught) { error = caught; }
		expect(error).toBeInstanceOf(StoreError);
		expect((error as StoreError).code).toBe('retry_after');
		// Refused from the cached row: no SQL, and SQL reservations still fit.
		expect(statements.length).toBe(before);
		expect(() => ledger.reserve({ reads: 10, writes: 10 }, noon, noon, false, false)).not.toThrow();
	});

	it('charges a reservation to its day, then writes it with what the work did not use refunded, in one update', () => {
		const { ledgerHost, table, state, statements } = host();
		const ledger = new BudgetLedger(ledgerHost, limits);
		ledger.start('2026-09-21');
		const reserved = ledger.reserve({ reads: 40, writes: 20, posts: 1 }, noon, noon, false, false);
		// Bookkeeping overhead (8) and the first reservation's handover (8).
		expect(reserved).toMatchObject({ reads: 56, writes: 36, posts: 1, day: '2026-09-21', maintenance: false });
		// Staged: checked against the cached copy, written when settled.
		expect(table.get('2026-09-21')).toMatchObject({ reads_reserved: 0, writes_reserved: 0, posts_reserved: 0 });
		expect(state.clock).toBe(noon);
		ledger.refund(reserved, 10, 5);
		// Credited down to the rows used plus the refund's own row.
		expect(table.get('2026-09-21')).toMatchObject({ reads_reserved: 11, writes_reserved: 6, foreground_reads: 11, foreground_writes: 6, posts_reserved: 1 });
		expect(statements.filter((query) => query.startsWith('UPDATE'))).toHaveLength(1);
		// With the effective clock.
		expect(statements.find((query) => query.startsWith('UPDATE'))).toMatch(/effective_ms = MAX\(effective_ms, \?\)/);
		expect(ledger.snapshot('2026-09-21')).toMatchObject({ reads: 11, writes: 6, posts: 1 });
	});

	it('holds a settling write back inside a transaction, which could roll it back, until the next one outside', () => {
		const { ledgerHost, table, state } = host();
		const ledger = new BudgetLedger(ledgerHost, limits);
		ledger.start('2026-09-21');
		state.inTransaction = true;
		ledger.refund(ledger.reserve({ reads: 10, writes: 10 }, noon, noon, false, false), 1, 1);
		expect(table.get('2026-09-21')).toMatchObject({ reads_reserved: 0 });
		state.inTransaction = false;
		ledger.refund(ledger.reserve({ reads: 10, writes: 10 }, noon, noon, false, false), 1, 1);
		// Both operations' rows, written together.
		expect(table.get('2026-09-21')).toMatchObject({ reads_reserved: 4, writes_reserved: 4 });
	});

	it('writes each day\'s staged change to its own row when one is held back across UTC midnight', () => {
		const { ledgerHost, table, state } = host();
		const ledger = new BudgetLedger(ledgerHost, limits);
		ledger.start('2026-09-21');
		const lastSecond = Date.parse('2026-09-21T23:59:59Z');
		state.inTransaction = true;
		ledger.refund(ledger.reserve({ reads: 10, writes: 10 }, lastSecond, lastSecond, false, false), 1, 1);
		ledger.refund(ledger.reserve({ reads: 10, writes: 10 }, lastSecond + 2_000, lastSecond + 2_000, false, false), 1, 1);
		state.inTransaction = false;
		ledger.flush();
		expect(table.get('2026-09-21')).toMatchObject({ reads_reserved: 2, writes_reserved: 2 });
		expect(table.get('2026-09-22')).toMatchObject({ reads_reserved: 2, writes_reserved: 2 });
		// A failed write is held back the same way.
		state.failUpdates = true;
		ledger.refund(ledger.reserve({ reads: 10, writes: 10 }, lastSecond + 3_000, lastSecond + 3_000, false, false), 1, 1);
		state.failUpdates = false;
		ledger.refund(ledger.reserve({ reads: 10, writes: 10 }, lastSecond + 86_400_000 + 2_000, lastSecond + 86_400_000 + 2_000, false, false), 1, 1);
		expect(table.get('2026-09-22')).toMatchObject({ reads_reserved: 4, writes_reserved: 4 });
		expect(table.get('2026-09-23')).toMatchObject({ reads_reserved: 2, writes_reserved: 2 });
	});

	it('refuses from the cached row without running SQL', () => {
		const { ledgerHost, statements, state } = host();
		const ledger = new BudgetLedger(ledgerHost, limits);
		ledger.start('2026-09-21');
		ledger.reserve({ writes: 770 }, noon, noon, false, false);
		const before = statements.length;
		let error: unknown;
		try { ledger.reserve({ writes: 100 }, noon, noon, false, false); } catch (caught) { error = caught; }
		expect(error).toBeInstanceOf(StoreError);
		expect((error as StoreError).code).toBe('retry_after');
		expect((error as StoreError).data).toEqual({ reason: 'daily_budget' });
		expect(statements.length).toBe(before);
		expect(state.unsafe).toBe(false);
		expect(() => ledger.checkConnection(noon)).toThrow(StoreError);
		// An admin command is charged but not refused.
		expect(() => ledger.reserve({ writes: 100 }, noon, noon, false, true)).not.toThrow();
	});

	it('keeps the maintenance control reserve for reserveControl alone', () => {
		const { ledgerHost, table } = host();
		const ledger = new BudgetLedger(ledgerHost, limits);
		ledger.start('2026-09-21');
		expect(() => ledger.reserve({ writes: 200 - 16 }, noon, noon, true, false)).toThrow('Maintenance budget exhausted');
		const control = ledger.reserveControl({ reads: 2, writes: 2 }, noon);
		expect(control.day).toBeUndefined();
		expect(table.get('2026-09-21')).toMatchObject({ maintenance_reads: 2, maintenance_writes: 2, foreground_writes: 0 });
	});

	it('latches accounting unsafe when a reservation cannot be written, and keeps it for the next write', () => {
		const { ledgerHost, state, table } = host();
		const ledger = new BudgetLedger(ledgerHost, limits);
		ledger.start('2026-09-21');
		state.failUpdates = true;
		const reserved = ledger.reserve({ writes: 1 }, noon, noon, false, false);
		ledger.refund(reserved, 0, 1);
		expect(state.unsafe).toBe(true);
		state.failUpdates = false;
		ledger.flush();
		expect(table.get('2026-09-21')?.writes_reserved).toBeGreaterThan(0);
	});

	it('loads a new day once, and prunes old rows once a day', () => {
		const { ledgerHost, statements } = host();
		const ledger = new BudgetLedger(ledgerHost, limits);
		ledger.wake('2026-09-20');
		ledger.reserve({ writes: 1 }, noon, noon, false, false);
		ledger.reserve({ writes: 1 }, noon, noon, false, false);
		expect(statements.filter((query) => query.startsWith('SELECT'))).toHaveLength(2);
		expect(statements.filter((query) => query.startsWith('DELETE'))).toHaveLength(1);
	});

	it('refuses in checkReservation exactly when reserve would refuse, without SQL or a reservation', () => {
		const DAY = 86_400_000;
		const cost = fc.record({ reads: fc.integer({ min: 0, max: 260 }), writes: fc.integer({ min: 0, max: 260 }), history: fc.integer({ min: 0, max: 2 }) });
		const prior = fc.array(fc.record({ cost, maintenance: fc.boolean(), at: fc.integer({ min: 0, max: DAY / 2 - 1 }) }), { maxLength: 6 });
		const probe = fc.record({ cost, maintenance: fc.boolean(), days: fc.constantFrom(0, 0, 1, 2), offset: fc.integer({ min: 0, max: DAY / 2 - 1 }) });
		/** Two ledgers driven alike: the same reservations (each refused one skipped alike), so their state is the same. */
		const ledgerAfter = (history: Array<{ cost: { reads: number; writes: number; history: number }; maintenance: boolean; at: number }>) => {
			const { ledgerHost, statements } = host();
			const ledger = new BudgetLedger(ledgerHost, limits);
			ledger.start('2026-09-21');
			const start = Date.parse('2026-09-21T00:00:00Z');
			for (const step of history) {
				try {
					const made = ledger.reserve(step.cost, start + step.at, start + step.at, step.maintenance, false);
					ledger.refund(made, step.cost.reads, step.cost.writes);
				} catch (error) {
					if (!(error instanceof StoreError) || error.code !== 'retry_after') throw error;
				}
			}
			return { ledger, statements, start };
		};
		const outcome = (fn: () => unknown): string => {
			try { fn(); return 'accepted'; } catch (error) {
				if (error instanceof StoreError && error.code === 'retry_after') return `refused: ${error.message}`;
				throw error;
			}
		};
		const warn = console.warn;
		console.warn = () => {};
		let answeredRuns = 0;
		try {
			fc.assert(fc.property(prior, probe, (history, probe) => {
				const checked = ledgerAfter(history);
				const reserved = ledgerAfter(history);
				const at = checked.start + probe.days * DAY + DAY / 2 + probe.offset;
				const before = checked.statements.length;
				let answered = true;
				const check = outcome(() => { answered = checked.ledger.checkReservation(probe.cost, at, probe.maintenance); });
				// The check touches no SQL and leaves the ledger as it was.
				expect(checked.statements.length).toBe(before);
				const reserve = outcome(() => reserved.ledger.reserve(probe.cost, at, at, probe.maintenance, false));
				// Where it answers (a row is cached: a reservation was accepted since the start) it agrees
				// with reserve. Where it can't, it refuses nothing and says so (the store then reserves).
				if (answered) expect(check).toBe(reserve);
				else expect(check).toBe('accepted');
				if (answered) answeredRuns++;
			}), { numRuns: 400 });
		} finally {
			console.warn = warn;
		}
		// Most runs had a cached row, so the comparison above really ran.
		expect(answeredRuns).toBeGreaterThan(200);
	});
});
