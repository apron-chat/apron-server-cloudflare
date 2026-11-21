import { describe, expect, it } from 'vitest';
import { HistorySchedule, isRefusal, refusalMessage } from '../../src/history/schedule';

describe('HistorySchedule', () => {
	it('lets one cycle or job run at a time, rewrites beside either but never beside an import', () => {
		const schedule = new HistorySchedule();
		const cycle = schedule.acquire({ kind: 'cycle' });
		expect(isRefusal(cycle)).toBe(false);
		expect(schedule.acquire({ kind: 'job', job: 'export' })).toEqual({ refused: 'cycle' });
		const rewrite = schedule.acquire({ kind: 'rewrite' });
		expect(isRefusal(rewrite)).toBe(false);
		if (isRefusal(cycle) || isRefusal(rewrite)) return;
		cycle.release();
		// A rewrite holds an import off, not an export.
		expect(schedule.acquire({ kind: 'job', job: 'import' })).toEqual({ refused: 'rewrite' });
		const exported = schedule.acquire({ kind: 'job', job: 'export' });
		expect(isRefusal(exported)).toBe(false);
		if (!isRefusal(exported)) exported.release();
		rewrite.release();
		const imported = schedule.acquire({ kind: 'job', job: 'import' });
		expect(isRefusal(imported)).toBe(false);
		const refused = schedule.acquire({ kind: 'rewrite' });
		expect(refused).toEqual({ refused: 'job', job: 'import' });
		expect(refusalMessage(refused as { refused: 'job'; job: 'import' })).toBe('A history import is running; try again when it ends');
		if (!isRefusal(imported)) {
			imported.release();
			expect(() => imported.release()).toThrow(/twice/);
		}
	});

	it('leaves a cycle that waits for a job due, and the job\'s release asks for it', () => {
		const schedule = new HistorySchedule();
		const job = schedule.acquire({ kind: 'job', job: 'backup' });
		expect(schedule.acquire({ kind: 'cycle' })).toEqual({ refused: 'job', job: 'backup' });
		expect(schedule.want).toEqual({ kind: 'due' });
		if (!isRefusal(job)) expect(job.release()).toEqual({ cycleSoon: true });
		const idle = schedule.acquire({ kind: 'job', job: 'export' });
		schedule.succeeded(false);
		if (!isRefusal(idle)) expect(idle.release()).toEqual({ cycleSoon: false });
	});

	it('backs off after failures, counting only failed steps, and a request ends the wait', () => {
		const schedule = new HistorySchedule();
		expect(schedule.workDue(0, () => false)).toBe(false);
		expect(schedule.want).toEqual({ kind: 'idle' });
		schedule.failed(100, 50, true);
		schedule.failed(100, 50, false);
		expect(schedule.want).toEqual({ kind: 'backoff', until: 150, failures: 1 });
		expect(schedule.retrying).toBe(true);
		expect(schedule.mayRun(149)).toBe(false);
		expect(schedule.workDue(149, () => true)).toBe(false);
		expect(schedule.workDue(150, () => false)).toBe(true);
		schedule.request();
		expect(schedule.mayRun(0)).toBe(true);
		expect(schedule.retrying).toBe(false);
	});

	it('reads queued ops once a wake: found, or unreadable, they make work due', () => {
		const schedule = new HistorySchedule();
		expect(schedule.workDue(0, () => { throw new Error('budget'); })).toBe(true);
		expect(schedule.want).toEqual({ kind: 'unknown' });
		expect(schedule.workDue(0, () => true)).toBe(true);
		expect(schedule.want).toEqual({ kind: 'due' });
	});
});
