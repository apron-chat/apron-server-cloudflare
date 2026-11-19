// Builds the package as it is published: dist/ holds compiled JS and .d.ts
// files, this README, the repository's LICENSE and a package.json whose
// exports name them. In this repository the workspace imports src/*.ts
// directly; consumers elsewhere install the build (`npm pack dist`, or a
// release tarball), so they need no TypeScript settings of their own.
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [join(root, "..", "..", "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "tsconfig.build.json")], { stdio: "inherit" });

// Declarations keep the sources' "./x.ts" specifiers; a consumer resolves "./x.js".
for (const file of readdirSync(dist)) {
	if (!file.endsWith(".d.ts")) continue;
	const path = join(dist, file);
	writeFileSync(path, readFileSync(path, "utf8").replace(/(from\s+["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2"));
}

const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const entry = (path) => {
	const base = path.replace(/^\.\/src\//, "./").replace(/\.ts$/, "");
	return { types: `${base}.d.ts`, default: `${base}.js` };
};
const { private: _private, scripts: _scripts, devDependencies: _dev, files: _files, exports, ...rest } = source;
const published = {
	...rest,
	exports: Object.fromEntries(Object.entries(exports).map(([key, path]) => [key, entry(path)])),
	types: "./index.d.ts",
	main: "./index.js",
};
writeFileSync(join(dist, "package.json"), `${JSON.stringify(published, null, "\t")}\n`);
copyFileSync(join(root, "README.md"), join(dist, "README.md"));
copyFileSync(join(root, "..", "..", "LICENSE"), join(dist, "LICENSE"));
console.log(`Built ${published.name}@${published.version} in ${dist}`);
