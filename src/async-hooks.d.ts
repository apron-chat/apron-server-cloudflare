// The part of node:async_hooks the Worker uses (nodejs_compat provides it at
// runtime), without pulling in every Node.js type.
declare module "node:async_hooks" {
	export class AsyncLocalStorage<T> {
		run<R>(store: T, callback: () => R): R;
		getStore(): T | undefined;
	}
}
