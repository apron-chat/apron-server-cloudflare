#!/usr/bin/env node
// The storage-cost profile of a typical session (test/cost-profile.integration.test.ts):
// SQLite rows read and written, and reserved, per protocol step.
//
//   node scripts/cost-profile.mjs                      run it and print the table
//   node scripts/cost-profile.mjs --write <file>       run it and save the profile (docs/cost-profile.json)
//   node scripts/cost-profile.mjs --check <file>       run it and compare with a saved profile; exit 1 when
//                                                      a step's actual reads or writes grew past the threshold
//   node scripts/cost-profile.mjs --compare <a> <b>    compare two saved profiles (no run); exits 1 as --check
//
// Options:
//   --repeat <n>        run the scenario n times and report any step whose numbers differ between runs
//   --from <file>       use this saved profile as the current one instead of running the test
//   --rows <n>          threshold: growth allowed in rows (default 2)
//   --percent <p>       threshold: growth allowed in percent of the baseline (default 5); a step fails
//                       when it grows by more than max(rows, percent of baseline)
//
// No dependencies. New and removed steps, and skipped ones, are reported, never failures.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST = "test/cost-profile.integration.test.ts";
const MARKER = "COST_PROFILE_JSON ";
const FIELDS = ["reads", "writes", "reservedReads", "reservedWrites"];

function parseArgs(argv) {
	const options = { repeat: 1, rows: 2, percent: 5 };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const value = () => {
			const next = argv[++index];
			if (next === undefined) fail(`${arg} needs a value`);
			return next;
		};
		switch (arg) {
			case "--write": options.write = value(); break;
			case "--check": options.check = value(); break;
			case "--compare": options.compare = [value(), value()]; break;
			case "--from": options.from = value(); break;
			case "--repeat": options.repeat = Math.max(1, Number.parseInt(value(), 10) || 1); break;
			case "--rows": options.rows = Number(value()); break;
			case "--percent": options.percent = Number(value()); break;
			case "-h": case "--help": usage(0); break;
			default: fail(`unknown argument ${arg}`);
		}
	}
	return options;
}

function usage(code) {
	console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((line) => line.startsWith("//")).map((line) => line.slice(3)).join("\n"));
	process.exit(code);
}

function fail(message) {
	console.error(`cost-profile: ${message}`);
	process.exit(2);
}

function git(...args) {
	const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Runs the test once; the profile it printed. */
function runOnce() {
	const result = spawnSync("npx", ["vitest", "run", TEST, "--reporter=verbose"], {
		cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
	});
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	const line = output.split("\n").find((text) => text.startsWith(MARKER));
	if (!line) {
		process.stderr.write(output);
		fail(`the test printed no ${MARKER.trim()} line (exit ${result.status})`);
	}
	if (result.status !== 0) {
		process.stderr.write(output);
		console.error(`cost-profile: the test failed (exit ${result.status}); its profile is reported anyway`);
	}
	// The test's own `version` (the server's, from its welcome) changes from run to run; the commit stands in for it.
	const raw = JSON.parse(line.slice(MARKER.length));
	return normalize({
		version: git("describe", "--always", "--dirty", "--tags") ?? "unknown",
		commit: git("rev-parse", "HEAD"),
		heldAlarms: raw.heldAlarms,
		steps: raw.steps,
	});
}

/** A profile with its keys in a stable order. */
function normalize(profile) {
	const out = { version: profile.version };
	if (profile.commit) out.commit = profile.commit;
	if (profile.heldAlarms !== undefined) out.heldAlarms = profile.heldAlarms;
	out.steps = profile.steps.map((step) => {
		const row = { step: step.step };
		for (const field of FIELDS) row[field] = step[field] ?? 0;
		if (step.n) row.n = step.n;
		if (step.skipped) row.skipped = step.skipped;
		return row;
	});
	return out;
}

function load(file) {
	try {
		return normalize(JSON.parse(readFileSync(file, "utf8")));
	} catch (error) {
		fail(`cannot read ${file}: ${error.message}`);
	}
}

function save(file, profile) {
	writeFileSync(file, `${JSON.stringify(normalize(profile), null, "\t")}\n`);
	console.log(`cost-profile: wrote ${file} (${profile.version}, ${profile.steps.length} steps)`);
}

/** Steps whose numbers differ between runs. */
function variance(runs) {
	const varying = [];
	for (const [index, step] of runs[0].steps.entries()) {
		const values = runs.map((run) => run.steps[index]);
		if (values.some((other) => !other || other.step !== step.step || FIELDS.some((field) => other[field] !== step[field]))) {
			varying.push({ step: step.step, values: values.map((other) => other ? FIELDS.map((field) => other[field]).join("/") : "missing") });
		}
	}
	if (runs.some((run) => run.steps.length !== runs[0].steps.length)) varying.push({ step: "(step count)", values: runs.map((run) => String(run.steps.length)) });
	return varying;
}

const pad = (text, width) => String(text).padEnd(width);
const lpad = (text, width) => String(text).padStart(width);

function cell(before, after) {
	if (before === undefined) return `${after}`;
	if (after === undefined) return `${before} -> -`;
	const delta = after - before;
	return delta === 0 ? `${after}` : `${before} -> ${after} (${delta > 0 ? "+" : ""}${delta})`;
}

/** Prints the comparison table; the failing steps. */
function compare(baseline, current, { rows, percent }) {
	const base = new Map(baseline?.steps.map((step) => [step.step, step]) ?? []);
	const seen = new Set();
	const lines = [];
	const failures = [];
	const notes = [];
	const allowed = (value) => Math.max(rows, (Math.abs(value) * percent) / 100);
	for (const step of current.steps) {
		seen.add(step.step);
		const before = base.get(step.step);
		let mark = " ";
		if (baseline && !before) { mark = "N"; notes.push(`new step: ${step.step}`); }
		else if (before && (before.skipped || step.skipped)) {
			if (before.skipped !== step.skipped) notes.push(`${step.step}: skipped ${before.skipped ? `in baseline (${before.skipped})` : ""}${step.skipped ? ` now (${step.skipped})` : ""}`.replace(/: skipped +/, ": skipped "));
			mark = "s";
		} else if (before) {
			const grew = ["reads", "writes"].filter((field) => step[field] - before[field] > allowed(before[field]));
			const up = FIELDS.some((field) => step[field] > before[field]);
			const down = FIELDS.some((field) => step[field] < before[field]);
			if (grew.length) { mark = "!"; failures.push({ step: step.step, fields: grew }); }
			else if (up) mark = "+";
			else if (down) mark = "-";
		}
		lines.push([mark, step.step + (step.n ? ` [n=${step.n}]` : "") + (step.skipped ? " (skipped)" : ""), ...FIELDS.map((field) => cell(before && !before.skipped ? before[field] : undefined, step.skipped ? undefined : step[field]))]);
	}
	for (const step of baseline?.steps ?? []) {
		if (seen.has(step.step)) continue;
		notes.push(`removed step: ${step.step}`);
		lines.push(["R", step.step, ...FIELDS.map((field) => cell(step[field], undefined))]);
	}
	const headers = [" ", "step", "reads", "writes", "reserved reads", "reserved writes"];
	const widths = headers.map((header, column) => Math.max(header.length, ...lines.map((line) => String(line[column]).length)));
	const format = (line) => line.map((value, column) => (column < 2 ? pad(value, widths[column]) : lpad(value, widths[column]))).join("  ").trimEnd();
	if (baseline) console.log(`baseline: ${baseline.version}${baseline.commit ? ` (${baseline.commit.slice(0, 12)})` : ""}   current: ${current.version}${current.commit ? ` (${current.commit.slice(0, 12)})` : ""}`);
	else console.log(`profile: ${current.version}`);
	console.log(format(headers));
	console.log(widths.map((width) => "-".repeat(width)).join("  "));
	for (const line of lines) console.log(format(line));
	const perOp = current.steps.filter((step) => step.n && !step.skipped);
	for (const step of perOp) {
		const before = base.get(step.step);
		const avg = (value, n) => (value / n).toFixed(1);
		console.log(`per operation, ${step.step}: reads ${before && !before.skipped ? `${avg(before.reads, before.n ?? step.n)} -> ` : ""}${avg(step.reads, step.n)}, writes ${before && !before.skipped ? `${avg(before.writes, before.n ?? step.n)} -> ` : ""}${avg(step.writes, step.n)}`);
	}
	console.log(`marks: ! grew past max(${rows} rows, ${percent}%)  + grew within it  - shrank  N new  R removed  s skipped`);
	for (const note of notes) console.log(`note: ${note}`);
	return failures;
}

const options = parseArgs(process.argv.slice(2));

if (options.compare) {
	const [a, b] = options.compare.map(load);
	const failures = compare(a, b, options);
	if (failures.length) {
		console.log(`\n${failures.length} step(s) grew past the threshold: ${failures.map((failure) => `${failure.step} (${failure.fields.join(", ")})`).join("; ")}`);
		process.exit(1);
	}
	process.exit(0);
}

let current;
if (options.from) current = load(options.from);
else {
	const runs = [];
	for (let run = 0; run < options.repeat; run += 1) runs.push(runOnce());
	current = runs[0];
	if (runs.length > 1) {
		const varying = variance(runs);
		if (varying.length) {
			console.log(`cost-profile: ${varying.length} step(s) differ between ${runs.length} runs (reads/writes/reservedReads/reservedWrites per run):`);
			for (const entry of varying) console.log(`  ${entry.step}: ${entry.values.join("  |  ")}`);
		} else console.log(`cost-profile: ${runs.length} runs identical`);
	}
}

if (options.write) save(options.write, current);
if (options.check) {
	const failures = compare(load(options.check), current, options);
	if (failures.length) {
		console.log(`\n${failures.length} step(s) grew past the threshold: ${failures.map((failure) => `${failure.step} (${failure.fields.join(", ")})`).join("; ")}`);
		process.exit(1);
	}
	console.log("\ncost-profile: no step grew past the threshold");
} else if (!options.write) compare(undefined, current, options);
