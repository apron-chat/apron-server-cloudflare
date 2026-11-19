/**
 * The command registry and its one dispatcher (`command`, §4.1). Each
 * command is a CommandSpec: its name, usage and help, who may run it, when
 * the deployment offers it, a parser from its words to typed arguments, and
 * a handler that takes only those. The dispatcher looks a command up,
 * authorizes the sender, parses, runs, and audits, in that order, for every
 * command alike; no handler checks who may run it.
 *
 * An admin command's handler gets an AdminCapability (capability.ts), and a
 * role-gated one's a RoleCapability, which the privileged runtime methods
 * demand: the type of `adminCommand`'s handler is what puts the capability
 * in its hands, and the type of `audit` is what makes every admin command
 * say what it acted on.
 */
import type { ProtocolError } from "../protocol";
import type { AuditDetails, AuditSink } from "./audit";
import { type AdminCapability, assertAdmin, assertRoles, authorizeAdmin, authorizeRoles, holdsRole, isAdmin, isOwner, type CommandIdentity, type RoleCapability } from "./capability";

/** Who may run a command: anyone, registered users (bots included), owners (registered users but bots), or admins. */
export type Audience = "everyone" | "registered" | "owners" | "admins";

/** A command line as the dispatcher split it, for a command's parser. */
export interface CommandLine {
	/** The command's text as sent. */
	readonly text: string;
	/** The text, trimmed. */
	readonly line: string;
	/** The line after its slash, split on whitespace: `words[0]` is the name as typed, and its arguments follow. */
	readonly words: readonly string[];
	/** The command's `body`, for what it has attached. */
	readonly body: Readonly<Record<string, unknown>>;
	/** The command's usage line, for its usage errors. */
	readonly usage: string;
}

/** What every handler's context carries; the runtime's own scope adds its connection, request and room. */
export interface ScopeBase {
	readonly runtime: unknown;
}

/** What each kind of command spec has. */
interface SpecBase<C extends ScopeBase, Args> {
	name: string;
	usage: string;
	help: string;
	/**
	 * What an `invalid_params` error from parsing or running becomes: `reply`
	 * answers it without counting a policy violation (a mistyped argument,
	 * which people make); `violation` throws it like any other refusal, which
	 * counts as one. Kept per command as each has always answered.
	 */
	usageErrors: "reply" | "violation";
	/** Whether this deployment offers the command now (a feature it needs is configured and on); always, when absent. */
	available?(runtime: C["runtime"]): boolean;
	/** The command's arguments from its line, or its usage error. Runs before anything changes. */
	parse(line: CommandLine, runtime: C["runtime"]): Args;
}

/** An admin command: its handler gets the capability, and it says what it acted on for the audit trail. */
export interface AdminSpec<C extends ScopeBase, Args> extends SpecBase<C, Args> {
	run(ctx: C & { readonly cap: AdminCapability }, args: Args): Promise<void> | void;
	audit(args: Args): AuditDetails;
}

/** An owners command for those holding one of `roles`: its handler gets the RoleCapability. */
export interface RoleSpec<C extends ScopeBase, Args> extends SpecBase<C, Args> {
	roles: readonly string[];
	run(ctx: C & { readonly grant: RoleCapability }, args: Args): Promise<void> | void;
}

/** A command anyone in its audience runs with no capability. */
export interface PlainSpec<C extends ScopeBase, Args> extends SpecBase<C, Args> {
	roles?: undefined;
	run(ctx: C, args: Args): Promise<void> | void;
}

/** A command for everyone; `posting` ones are listed only to those who may post. */
export interface PublicSpec<C extends ScopeBase, Args> extends PlainSpec<C, Args> {
	posting?: boolean;
}

/** Any command spec, by audience. */
export type CommandSpec<C extends ScopeBase, Args> =
	| (AdminSpec<C, Args> & { audience: "admins" })
	| ((RoleSpec<C, Args> | PlainSpec<C, Args>) & { audience: "owners" })
	| (PlainSpec<C, Args> & { audience: "registered" })
	| (PublicSpec<C, Args> & { audience: "everyone" });

/** The capabilities the dispatcher issued for one command. */
export interface Grants {
	readonly admin?: AdminCapability;
	readonly roles?: RoleCapability;
}

/** A command's handler call with its arguments parsed, and what they tell the audit trail. */
export interface PreparedCommand<C extends ScopeBase> {
	readonly details: AuditDetails;
	run(ctx: C, grants: Grants): Promise<void>;
}

/** A registered command: its spec with the argument type sealed in, as the table and dispatcher hold it. */
export interface Command<C extends ScopeBase> {
	readonly name: string;
	readonly usage: string;
	readonly help: string;
	readonly audience: Audience;
	readonly roles?: readonly string[];
	readonly usageErrors: "reply" | "violation";
	readonly posting: boolean;
	available(runtime: C["runtime"]): boolean;
	/** Parses a line into this command's handler call (throwing its usage error); the dispatcher's alone. */
	prepare(line: CommandLine, runtime: C["runtime"]): PreparedCommand<C>;
}

/** The helpers that make each kind of command, typed for one runtime's scope (defineCommands). */
export interface CommandHelpers<C extends ScopeBase> {
	adminCommand<Args>(spec: AdminSpec<C, Args>): Command<C>;
	ownerCommand<Args>(spec: RoleSpec<C, Args>): Command<C>;
	ownerCommand<Args>(spec: PlainSpec<C, Args>): Command<C>;
	registeredCommand<Args>(spec: PlainSpec<C, Args>): Command<C>;
	publicCommand<Args>(spec: PublicSpec<C, Args>): Command<C>;
}

/** Seals a spec into a Command: `bind` turns its parsed arguments into the handler call, checking the grants it needs. */
function seal<C extends ScopeBase, Args>(
	spec: SpecBase<C, Args>, audience: Audience, roles: readonly string[] | undefined, posting: boolean,
	bind: (args: Args) => (ctx: C, grants: Grants) => Promise<void> | void, audit?: (args: Args) => AuditDetails,
): Command<C> {
	return Object.freeze({
		name: spec.name, usage: spec.usage, help: spec.help, audience, ...(roles ? { roles } : {}), usageErrors: spec.usageErrors, posting,
		available: (runtime: C["runtime"]) => spec.available?.(runtime) ?? true,
		prepare(line: CommandLine, runtime: C["runtime"]): PreparedCommand<C> {
			const args = spec.parse(line, runtime);
			const call = bind(args);
			return { details: audit?.(args) ?? {}, run: async (ctx, grants) => { await call(ctx, grants); } };
		},
	});
}

/** The helpers, typed for one runtime's scope: each seals its spec with the audience it names and the grants it needs. */
function helpersFor<C extends ScopeBase>(): CommandHelpers<C> {
	return {
		adminCommand: (spec) => seal(spec, "admins", undefined, false, (args) => (ctx, grants) => {
			assertAdmin(grants.admin);
			return spec.run({ ...ctx, cap: grants.admin }, args);
		}, spec.audit),
		ownerCommand: <Args>(spec: RoleSpec<C, Args> | PlainSpec<C, Args>) => {
			if (spec.roles === undefined) {
				const plain = spec;
				return seal(plain, "owners", undefined, false, (args) => (ctx) => plain.run(ctx, args));
			}
			const gated = spec;
			return seal(gated, "owners", gated.roles, false, (args) => (ctx, grants) => {
				assertRoles(grants.roles, gated.roles);
				return gated.run({ ...ctx, grant: grants.roles }, args);
			});
		},
		registeredCommand: (spec) => seal(spec, "registered", undefined, false, (args) => (ctx) => spec.run(ctx, args)),
		publicCommand: (spec) => seal(spec, "everyone", undefined, spec.posting === true, (args) => (ctx) => spec.run(ctx, args)),
	};
}

/**
 * A runtime's commands, in the order `/help` lists them: alphabetical,
 * which the constructor checks, with no name twice.
 */
export class CommandTable<C extends ScopeBase> {
	readonly commands: readonly Command<C>[];

	constructor(commands: readonly Command<C>[]) {
		for (let index = 1; index < commands.length; index++) {
			if (!(commands[index - 1].name < commands[index].name)) throw new Error(`Commands are listed alphabetically, each once: /${commands[index].name} is out of place`);
		}
		this.commands = Object.freeze([...commands]);
	}

	/** The command named `name` if this deployment offers it now; only its own availability is checked. */
	find(name: string, runtime: C["runtime"]): Command<C> | undefined {
		const command = this.commands.find((candidate) => candidate.name === name);
		return command?.available(runtime) ? command : undefined;
	}

	/** The command named `name`, offered or not: for its usage line. */
	get(name: string): Command<C> {
		const command = this.commands.find((candidate) => candidate.name === name);
		if (!command) throw new Error(`No command /${name}`);
		return command;
	}

	/**
	 * The commands offered now that the sender may run, as `/help` lists
	 * them: those for everyone (the `posting` ones only if they may post,
	 * `posts`), for registered users if they are one, for owners if they are
	 * one holding any roles the command needs, and every one for an admin.
	 */
	listFor(identity: CommandIdentity, runtime: C["runtime"], posts: boolean): Command<C>[] {
		const owner = isOwner(identity);
		const admin = isAdmin(identity);
		return this.commands.filter((command) => command.available(runtime) && (
			(command.audience === "everyone" && (posts || !command.posting)) ||
			(command.audience === "registered" && identity.tier === "registered") ||
			(command.audience === "owners" && owner && (!command.roles || command.roles.some((role) => holdsRole(identity, role)))) ||
			admin));
	}
}

/** Builds a runtime's command table from its specs, made with helpers typed for its scope `C`. */
export function defineCommands<C extends ScopeBase>(build: (define: CommandHelpers<C>) => readonly Command<C>[]): CommandTable<C> {
	return new CommandTable(build(helpersFor<C>()));
}

/** `/help`'s list: each command's usage and help, admins' marked "(admin-only)". */
export function helpText(commands: readonly Command<ScopeBase>[]): string {
	return commands.map((command) => `- \`${command.usage}\`: ${command.help}${command.audience === "admins" ? " (admin-only)" : ""}`).join("\n");
}

/** What the dispatcher needs of the runtime beyond the handlers' scope. */
export interface DispatchHost {
	/** Answers the command with an error that is no policy violation. */
	fail(error: ProtocolError): void;
	/** The protocol error a thrown value is, as the runtime answers it. */
	protocolOf(error: unknown): ProtocolError;
	/** Where admin commands' audit events go. */
	readonly audit: AuditSink;
	/** The time the command arrived, in epoch milliseconds. */
	readonly now: number;
}

/**
 * Checks the sender against the command's audience and roles, in the
 * order the commands have always been refused in, each refusal `denied`;
 * an admin command's refusal is audited (authorizeAdmin). Returns the
 * capabilities the command's handler needs.
 */
function authorize<C extends ScopeBase>(command: Command<C>, identity: CommandIdentity, host: DispatchHost): Grants {
	const name = command.name;
	if (command.audience === "registered" && identity.tier !== "registered") throw { name: "denied", message: `Sign in with a passkey to use /${name}` } satisfies ProtocolError;
	if (command.audience === "owners" && !isOwner(identity)) {
		throw { name: "denied", message: holdsRole(identity, "bot") ? `A bot can't use /${name}` : `Sign in with a passkey to use /${name}` } satisfies ProtocolError;
	}
	const admin = command.audience === "admins" ? authorizeAdmin(identity, name, host.audit, host.now) : undefined;
	const roles = command.roles ? authorizeRoles(identity, name, command.roles) : undefined;
	return { ...(admin ? { admin } : {}), ...(roles ? { roles } : {}) };
}

/** Whether a command's body carries a live text embed, which goes in a message instead (§4.8.3). */
function hasLiveEmbed(body: Readonly<Record<string, unknown>>): boolean {
	return Array.isArray(body.embeds) && body.embeds.some((embed) => !!embed && typeof embed === "object" && ["terminal", "append"].includes((embed as Record<string, unknown>).kind as string));
}

/**
 * Runs one command line from `identity`, in this order: look the command
 * up among those offered (an unknown one is an error to show, not a policy
 * violation, since people mistype); authorize (audience, roles, and for an
 * admin command, the capability); refuse a live text embed; parse; run.
 * An admin command that passed authorization records one audit event,
 * `ok` or `failed` with the error's name. An `invalid_params` error from
 * parsing or running is answered as the command's `usageErrors` says;
 * anything else is thrown, for the caller to answer and count.
 */
export async function dispatchCommand<C extends ScopeBase>(
	table: CommandTable<C>, ctx: C, identity: CommandIdentity, text: string, body: Readonly<Record<string, unknown>>, host: DispatchHost,
): Promise<void> {
	const line = text.trim();
	const words = line.startsWith("/") ? line.slice(1).split(/\s+/) : [""];
	const name = words[0].toLowerCase();
	const command = table.find(name, ctx.runtime);
	if (!command) {
		const message = line.startsWith("/") ? `Unknown command /${name}; try /help` : "A command starts with /; try /help";
		host.fail({ name: "invalid_params", message: message.slice(0, 200) });
		return;
	}
	const grants = authorize(command, identity, host);
	let details: AuditDetails = {};
	// Live text starts with its own commands, or in a message (§4.8.3).
	if (hasLiveEmbed(body)) {
		grants.admin?.settle("failed", details, "invalid_params");
		throw { name: "invalid_params", message: "A terminal or append embed goes in a message; or use /embed-terminal or /embed-append" } satisfies ProtocolError;
	}
	try {
		const prepared = command.prepare({ text, line, words, body, usage: command.usage }, ctx.runtime);
		details = prepared.details;
		await prepared.run(ctx, grants);
	} catch (error) {
		const protocol = host.protocolOf(error);
		grants.admin?.settle("failed", details, protocol.name);
		if (command.usageErrors === "reply" && protocol.name === "invalid_params") {
			host.fail(protocol);
			return;
		}
		throw error;
	}
	grants.admin?.settle("ok", details);
}
