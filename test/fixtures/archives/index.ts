/// <reference types="vite/client" />
/*
 * The archive fixtures as strings, by scene name (README.md here). The
 * Workers test pool has no filesystem, so Vite bundles them at build time.
 */

const files = import.meta.glob("./*.jsonl", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Scene name (the file name without `.jsonl`) → the file's text. */
export const sceneArchives: Readonly<Record<string, string>> = Object.fromEntries(
	Object.entries(files).map(([path, text]) => [path.replace(/^\.\//, "").replace(/\.jsonl$/, ""), text]),
);
