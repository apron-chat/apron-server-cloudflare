import { describe, expect, it, vi } from "vitest";
import { ACCOUNT_USAGE_POLICY } from "../src/budget";
import { accountUsageSnapshotFromResult, exceededAllowances, fetchAccountUsage } from "../src/account-usage";
import { env, runInDurableObject } from "cloudflare:test";
import { Store } from "../src/store";

function result(overrides: Record<string, unknown> = {}) {
	const base = {
		workersInvocationsAdaptive: [{ sum: { requests: 1 } }],
		durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 2 } }],
		durableObjectsPeriodicGroups: [{ sum: { duration: 3, rowsRead: 4, rowsWritten: 5 } }],
		durableObjectsStorageGroups: [{ max: { storedBytes: 6 } }],
		monthWorkers: [{ sum: { requests: 10, cpuTimeUs: 7_000 } }],
		monthInvocations: [{ dimensions: { type: "http" }, sum: { requests: 20 } }, { dimensions: { type: "hibernation" }, sum: { requests: 40 } }],
		monthPeriodic: [{ sum: { duration: 30, rowsRead: 40, rowsWritten: 50 } }],
		r2Operations: [
			{ dimensions: { actionType: "PutObject" }, sum: { requests: 3 } },
			{ dimensions: { actionType: "GetObject" }, sum: { requests: 5 } },
			{ dimensions: { actionType: "DeleteObject" }, sum: { requests: 7 } },
			{ dimensions: { actionType: "SomethingNew" }, sum: { requests: 1 } },
		],
		r2Storage: [{ dimensions: { bucketName: "a" }, max: { payloadSize: 100, metadataSize: 10 } }, { dimensions: { bucketName: "b" }, max: { payloadSize: 1, metadataSize: 0 } }],
		monthR2Operations: [{ dimensions: { actionType: "PutObject" }, sum: { requests: 30 } }, { dimensions: { actionType: "HeadObject" }, sum: { requests: 50 } }],
	};
	return { data: { viewer: { accounts: [{ ...base, ...overrides }] } } };
}

describe("account usage snapshots", () => {
	it("queries the supported Workers dataset and parses the response", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			const { query } = JSON.parse(String(init?.body));
			expect(query).toContain("workersInvocationsAdaptive(");
			return Response.json(result());
		});
		try {
			const snapshot = await fetchAccountUsage({ ACCOUNT_ID: "test-account", ACCOUNT_ANALYTICS_TOKEN: "test-token" });
			expect(snapshot.workerRequests).toBe(1);
			expect(fetchSpy).toHaveBeenCalledOnce();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("normalizes account datasets below the stop threshold", () => {
		const snapshot = accountUsageSnapshotFromResult(result(), Date.parse("2026-09-21T12:00:00Z"));
		expect(snapshot).toMatchObject({ day: "2026-09-21", workerRequests: 1, durableObjectRequests: 2, sqlRowsRead: 4, sqlRowsWritten: 5, storedBytes: 6, stop: false });
	});

	it("bills incoming WebSocket messages at the plan's ratio", async () => {
		const snapshot = accountUsageSnapshotFromResult(result({
			durableObjectsInvocationsAdaptiveGroups: [
				{ dimensions: { type: "http" }, sum: { requests: 3 } },
				{ dimensions: { type: "hibernation" }, sum: { requests: 40 } },
				{ dimensions: { type: "alarm" }, sum: { requests: 1 } },
			],
		}), Date.now());
		expect(snapshot.durableObjectRequests).toBe(4 + 40 / ACCOUNT_USAGE_POLICY.webSocketMessagesPerRequest);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			expect(JSON.parse(String(init?.body)).query).toMatch(/durableObjectsInvocationsAdaptiveGroups\([^)]*\) \{ dimensions \{ type \}/);
			return Response.json(result());
		});
		try {
			await fetchAccountUsage({ ACCOUNT_ID: "test-account", ACCOUNT_ANALYTICS_TOKEN: "test-token" });
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("stops when any shared allowance reaches the configured ratio", () => {
		const snapshot = accountUsageSnapshotFromResult(result({
			workersInvocationsAdaptive: [{ sum: { requests: ACCOUNT_USAGE_POLICY.daily.workerRequests * ACCOUNT_USAGE_POLICY.stopRatio } }],
		}), Date.now());
		expect(snapshot.stop).toBe(true);
	});

	it("reads usage since the start of the month and stops at the monthly ratio", () => {
		const { monthly, monthlyStopRatio: ratio } = ACCOUNT_USAGE_POLICY;
		const snapshot = accountUsageSnapshotFromResult(result(), Date.parse("2026-09-21T12:00:00Z"));
		// A plan that fails closed at its allowances, like Free, reads no month.
		if (!monthly || !ratio) return expect(snapshot.month).toBeUndefined();
		expect(snapshot.month).toEqual({
			month: "2026-09",
			workerRequests: 10,
			workerCpuMs: 7,
			durableObjectRequests: 20 + 40 / ACCOUNT_USAGE_POLICY.webSocketMessagesPerRequest,
			durableObjectDurationGbSeconds: 30,
			sqlRowsRead: 40,
			sqlRowsWritten: 50,
			logEvents: 70,
			...(ACCOUNT_USAGE_POLICY.r2 ? { r2: { classAOperations: 30, classBOperations: 50 } } : {}),
		});
		expect(exceededAllowances(snapshot)).toEqual([]);
		// Well under the daily share, but past the month's ratio.
		const overMonth = accountUsageSnapshotFromResult(result({
			monthWorkers: [{ sum: { requests: 1, cpuTimeUs: monthly.workerCpuMs * ratio * 1_000 } }],
		}), Date.now());
		expect(overMonth.stop).toBe(true);
		expect(exceededAllowances(overMonth)).toEqual(["monthly.workerCpuMs"]);
		const overDay = accountUsageSnapshotFromResult(result({
			workersInvocationsAdaptive: [{ sum: { requests: ACCOUNT_USAGE_POLICY.daily.workerRequests } }],
		}), Date.now());
		expect(exceededAllowances(overDay)).toEqual(["daily.workerRequests"]);
		expect(() => accountUsageSnapshotFromResult(result({ monthWorkers: undefined }), Date.now())).toThrow();
	});

	it("counts R2 operations by class, free ones aside, and stops at R2's shares", () => {
		const r2 = ACCOUNT_USAGE_POLICY.r2;
		const snapshot = accountUsageSnapshotFromResult(result(), Date.now());
		if (!r2) return expect(snapshot.r2).toBeUndefined();
		// An action R2 does not list yet counts as the dearer Class A.
		expect(snapshot.r2).toEqual({ classAOperations: 4, classBOperations: 5, storedBytes: 111 });
		expect(snapshot.month?.r2).toEqual({ classAOperations: 30, classBOperations: 50 });
		expect(exceededAllowances(snapshot)).toEqual([]);
		const reads = accountUsageSnapshotFromResult(result({
			r2Operations: [{ dimensions: { actionType: "GetObject" }, sum: { requests: Math.ceil(r2.classBOperationsMonthly / 31) } }],
		}), Date.now());
		expect(exceededAllowances(reads)).toEqual(["daily.r2ClassBOperations"]);
		const month = accountUsageSnapshotFromResult(result({
			monthR2Operations: [{ dimensions: { actionType: "PutObject" }, sum: { requests: r2.classAOperationsMonthly / 2 } }],
		}), Date.now());
		expect(exceededAllowances(month)).toEqual(["monthly.r2ClassAOperations"]);
		const stored = accountUsageSnapshotFromResult(result({ r2Storage: [{ max: { payloadSize: r2.storedBytes, metadataSize: 0 } }] }), Date.now());
		expect(exceededAllowances(stored)).toEqual(["r2StoredBytes"]);
	});

	it("queries today and the month so far", async () => {
		const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const { query } = JSON.parse(String(init?.body));
			expect(query).toContain('workersInvocationsAdaptive(filter: { datetime_geq: "2026-09-21T00:00:00.000Z", datetime_leq: "2026-09-21T12:00:00.000Z" }');
			if (!ACCOUNT_USAGE_POLICY.monthly) expect(query).not.toContain("month");
			else {
				expect(query).toContain('monthWorkers: workersInvocationsAdaptive(filter: { datetime_geq: "2026-09-01T00:00:00.000Z", datetime_leq: "2026-09-21T12:00:00.000Z" }, limit: 1000) { sum { requests cpuTimeUs } }');
				expect(query).toContain("monthInvocations: durableObjectsInvocationsAdaptiveGroups(");
				expect(query).toContain("monthPeriodic: durableObjectsPeriodicGroups(");
				expect(query).toContain("r2Operations: r2OperationsAdaptiveGroups(");
				expect(query).toContain("r2Storage: r2StorageAdaptiveGroups(");
				expect(query).toContain("monthR2Operations: r2OperationsAdaptiveGroups(");
			}
			return Response.json(result());
		});
		await fetchAccountUsage({ ACCOUNT_ID: "test-account", ACCOUNT_ANALYTICS_TOKEN: "test-token" }, Date.parse("2026-09-21T12:00:00Z"), undefined, fetcher);
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("fails closed on API errors or missing datasets instead of treating them as zero", () => {
		expect(() => accountUsageSnapshotFromResult({ errors: [{ message: "denied" }] }, Date.now())).toThrow();
		expect(() => accountUsageSnapshotFromResult({ data: { viewer: { accounts: [{}] } } }, Date.now())).toThrow();
	});

	it("rejects negative or non-numeric usage values", () => {
		expect(() => accountUsageSnapshotFromResult(result({
			workersInvocationsAdaptive: [{ sum: { requests: -1 } }],
		}), Date.now())).toThrow();
		expect(() => accountUsageSnapshotFromResult(result({
			durableObjectsPeriodicGroups: [{ sum: { duration: "unknown", rowsRead: 1, rowsWritten: 1 } }],
		}), Date.now())).toThrow();
	});

	it("persists the snapshot in existing Durable Object metadata", async () => {
		const snapshot = accountUsageSnapshotFromResult(result(), Date.parse("2026-09-21T12:00:00Z"));
		await runInDurableObject(env.DEMO.getByName("account-usage-snapshot"), (_instance, state) => {
			const store = new Store(state, {});
			store.initialize();
			store.persistAccountUsageSnapshot(snapshot);
			const restarted = new Store(state, {});
			restarted.initialize();
			expect(restarted.accountUsageSnapshot()).toEqual(snapshot);
		});
	});
});
