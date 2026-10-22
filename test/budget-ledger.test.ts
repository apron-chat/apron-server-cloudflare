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
};

/** A stand-in for the store's metered SQL over one in-memory table of day rows. */
function host() {
	const table = new Map<string, RawBudgetRow>();
	const statements: string[] = [];
	const state = { unsafe: false, clock: 0, failUpdates: false };
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
		markUnsafe() { state.unsafe = true; },
	};
	return { ledgerHost, table, statements, state };
}

const noon = Date.parse('2026-09-21T12:00:00Z');

describe('budget ledger', () => {
	it('charges a reservation to its day, then refunds what the work did not use', () => {
		const { ledgerHost, table, state } = host();
		const ledger = new BudgetLedger(ledgerHost, limits);
		ledger.start('2026-09-21');
		const reserved = ledger.reserve({ reads: 40, writes: 20, posts: 1 }, noon, noon, false, false);
		// Bookkeeping overhead (8) and the first reservation's handover (8).
		expect(reserved).toMatchObject({ reads: 56, writes: 36, posts: 1, day: '2026-09-21', maintenance: false });
		expect(table.get('2026-09-21')).toMatchObject({ reads_reserved: 56, writes_reserved: 36, foreground_writes: 36, posts_reserved: 1, maintenance_writes: 0 });
		expect(state.clock).toBe(noon);
		ledger.refund(reserved, 10, 5);
		// Credited down to the rows used plus the refund's own row.
		expect(table.get('2026-09-21')).toMatchObject({ reads_reserved: 11, writes_reserved: 6, foreground_reads: 11, foreground_writes: 6 });
		expect(ledger.snapshot('2026-09-21')).toMatchObject({ reads: 11, writes: 6, posts: 1 });
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

	it('latches accounting unsafe when a reservation cannot be written', () => {
		const { ledgerHost, state } = host();
		const ledger = new BudgetLedger(ledgerHost, limits);
		ledger.start('2026-09-21');
		state.failUpdates = true;
		expect(() => ledger.reserve({ writes: 1 }, noon, noon, false, false)).toThrow('storage failure');
		expect(state.unsafe).toBe(true);
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
});
