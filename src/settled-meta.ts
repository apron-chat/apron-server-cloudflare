/**
 * A `_meta` value that an operation must leave behind even when it fails: a
 * latch or marker set on the way to a refusal, whose throw rolls back the
 * transaction it was set in.
 *
 * Writing such a value with plain SQL inside the transaction is wrong by
 * construction: the refusal that follows erases it, so whether it sticks
 * depends on whether the caller happened to hold a transaction. A
 * SettledMeta keeps the value in memory instead; `set` only changes that, and
 * the owner calls `flush` once every outermost transaction has ended,
 * committed or rolled back (and at once outside one). So no rollback can
 * erase it, and a write that fails is tried again by the next flush.
 *
 * The value is read from storage once, lazily, and then held: the owner must
 * be the only writer of its key, and must `forget` it when storage is wiped.
 */
export class SettledMeta {
	/** The value as storage holds it; undefined until read. */
	private stored: string | undefined;
	/** The value as it should be; undefined until read or set. */
	private desired: string | undefined;

	constructor(readonly key: string) {}

	/** The value, read from storage with `read` the first time. */
	value(read: (key: string) => string): string {
		if (this.desired === undefined) this.load(read(this.key));
		return this.desired!;
	}

	/** What storage was last read or written to hold, if known. */
	get persisted(): string | undefined {
		return this.stored;
	}

	/** Takes `value` as what storage holds, discarding any change not yet written. */
	load(value: string): void {
		this.stored = value;
		this.desired = value;
	}

	/** Changes the value; storage follows at the next flush. */
	set(value: string): void {
		this.desired = value;
	}

	/** Whether a change awaits its write. */
	get dirty(): boolean {
		return this.desired !== undefined && this.desired !== this.stored;
	}

	/**
	 * Writes the value if it changed. Returns false, keeping the change for
	 * the next flush, if `write` throws.
	 */
	flush(write: (key: string, value: string) => void): boolean {
		if (!this.dirty) return true;
		try {
			write(this.key, this.desired!);
		} catch {
			return false;
		}
		this.stored = this.desired;
		return true;
	}

	/** Forgets both values, as after storage is wiped: the next read reloads. */
	forget(): void {
		this.stored = undefined;
		this.desired = undefined;
	}
}
