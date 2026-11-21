// `npm run roundtrip -- <file or directory>...`: runs the scene round trip
// (test/history/roundtrip.integration.test.ts: import, export, import,
// export through a fresh server each time, then compares) on the archives
// named. A directory stands for every scene.jsonl in it or one level below
// it, as in scene.apron.chat's scenes/<name>/scene.jsonl. The Workers test
// pool cannot read the host's files, so vitest.config.ts reads them
// (ROUNDTRIP_SCENES) and hands them in as a binding. --with-fixtures runs
// the archive package's scene fixtures too.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

const args = process.argv.slice(2);
const withFixtures = args.includes("--with-fixtures");
const files = [];
for (const arg of args.filter((value) => value !== "--with-fixtures")) {
	const path = resolve(arg);
	if (!existsSync(path)) throw new Error(`No such file or directory: ${arg}`);
	if (!statSync(path).isDirectory()) {
		files.push(path);
		continue;
	}
	const own = join(path, "scene.jsonl");
	if (existsSync(own)) files.push(own);
	for (const entry of readdirSync(path).sort()) {
		const nested = join(path, entry, "scene.jsonl");
		if (statSync(join(path, entry)).isDirectory() && existsSync(nested)) files.push(nested);
	}
}
if (!files.length && !withFixtures) {
	console.error("Usage: npm run roundtrip -- <scene.jsonl or directory>... [--with-fixtures]");
	process.exit(2);
}
console.log(`Round-tripping ${files.length} archive(s)${withFixtures ? " and the fixtures" : ""}:\n${files.map((file) => `  ${file}`).join("\n")}`);
const result = spawnSync("npx", ["vitest", "run", "test/history/roundtrip.integration.test.ts"], {
	stdio: "inherit",
	env: { ...process.env, ROUNDTRIP_SCENES: files.join(delimiter), ...(withFixtures ? {} : { ROUNDTRIP_ONLY: "1" }) },
});
process.exit(result.status ?? 1);
