/**
 * The command registry and its one dispatcher (`command`, §4.1). Each
 * command is a CommandSpec: its name, its forms (what `/help`, usage errors
 * and `ext:command_list` say of it), who may run it, when the deployment
 * offers it, a parser from its words to typed arguments, and a handler that
 * takes only those. The dispatcher looks a command up,
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

/** A field of a `command` request (§4.1), besides `body.text`, that changes what a command does (extension `ext:command_list`). */
export type CommandField = "room_id" | "reply_to" | "body.mentions" | "body.embeds";

/**
 * One form of a command, as `/help` and `ext:command_list` list it. A
 * command with fixed words after its name, such as `/emoji add` and
 * `/emoji remove`, has a form for each; words that only choose a value,
 * such as `/toggle`'s feature, stay in the hint. `R` is the runtime.
 */
export interface CommandForm<R = unknown> {
	/** The fixed words after the command's name that choose this form, such as `add`; absent for the name alone. */
	readonly words?: string;
	/**
	 * The text after the form's name, in `ext:command_list`'s suggested
	 * convention: `<value>` to replace, `[…]` optional, `a|b` choices, `...`
	 * repeats, `@user` a user written with its prefix; absent when nothing
	 * follows the name. A function gives it from the runtime, where the
	 * choices depend on what the deployment configures.
	 */
	readonly hint?: string | ((runtime: R) => string);
	/** What the form does, in plain text, not blank. */
	readonly description: string;
	/**
	 * The request fields besides `body.text` its handler reads: `room_id`
	 * where it acts on the room it is sent in (not where it only sends its
	 * reply), and `reply_to`, `body.mentions` or `body.embeds` where it takes
	 * them, not where it only refuses them.
	 */
	readonly uses?: readonly CommandField[];
	/**
	 * Those of `uses` it fails without. A form that requires `room_id` acts
	 * only on a room the client names: the dispatcher refuses it without
	 * one, rather than run it in the default room.
	 */
	readonly requires?: readonly CommandField[];
	/**
	 * Whether `/help` and `ext:command_list` offer the form to `identity`
	 * now, beyond its command's audience and availability, such as a form
	 * that needs uploads on; always, when absent. Its command still takes a
	 * form not offered, and refuses it as it always has.
	 */
	offered?(runtime: R, identity: CommandIdentity): boolean;
}

/**
 * Who may use a command, as `ext:command_list` groups it for display, from
 * the widest to the narrowest: `all` (everyone), `guest`, `member`
 * (registered users and owners), `room` (those with a part in running a
 * room), `role` (owners holding one of a command's roles) or `admin`. No
 * command here is for guests alone, or gated on a room.
 */
export type CommandGroup = "all" | "guest" | "member" | "room" | "role" | "admin";

/** A command's group, from its audience and roles. */
function groupOf(audience: Audience, roles: readonly string[] | undefined): CommandGroup {
	if (audience === "everyone") return "all";
	if (audience === "admins") return "admin";
	return roles ? "role" : "member";
}

/** A command's forms offered to one sender (CommandTable.listFor), with the audience `/help` marks. */
export interface OfferedCommand {
	readonly audience: Audience;
	readonly forms: readonly ListedForm[];
}

/** A form as `ext:command_list` returns it: its full name, its command's group, its description, and its hint, uses and requires where it has them. */
export interface ListedForm {
	readonly name: string;
	readonly group: CommandGroup;
	readonly description: string;
	readonly hint?: string;
	readonly uses?: readonly CommandField[];
	readonly requires?: readonly CommandField[];
}

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
	/** The command's usage, each of its forms (formsUsage), for its usage errors. */
	readonly usage: string;
}

/** What every handler's context carries; the runtime's own scope adds its connection, request and room. */
export interface ScopeBase {
	readonly runtime: unknown;
}

/** What each kind of command spec has. */
interface SpecBase<C extends ScopeBase, Args> {
	name: string;
	/** Its forms, in the order of their names, the name alone first where it is one. */
	forms: readonly [CommandForm<C["runtime"]>, ...CommandForm<C["runtime"]>[]];
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
	/** Its forms' names, in order. */
	readonly formNames: readonly string[];
	readonly audience: Audience;
	/** Who may use it, as `ext:command_list` groups it. */
	readonly group: CommandGroup;
	readonly roles?: readonly string[];
	readonly usageErrors: "reply" | "violation";
	readonly posting: boolean;
	available(runtime: C["runtime"]): boolean;
	/** Its forms as listed, with their hints for `runtime`: those offered to `identity`, or every one without it. */
	forms(runtime: C["runtime"], identity?: CommandIdentity): ListedForm[];
	/** Its usage, every form (formsUsage), for its usage errors. */
	usage(runtime: C["runtime"]): string;
	/** What the form a line names requires (formOf): its full name and its `requires`. */
	requiredBy(words: readonly string[]): { readonly name: string; readonly requires: readonly CommandField[] };
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

/** A form's full name: the command's name, then its words. */
function formName(name: string, form: CommandForm<never>): string {
	return form.words ? `${name} ${form.words}` : name;
}

/**
 * Checks a spec's forms say what `ext:command_list` asks: each name words
 * of no whitespace, one space apart; a description that is not blank; a
 * hint, where it is text, that is not blank; and `uses` and `requires`
 * without repeats, `requires` within `uses`.
 */
function checkForms(name: string, forms: readonly CommandForm<never>[]): void {
	const unique = (fields: readonly string[] | undefined) => !fields || new Set(fields).size === fields.length;
	for (const form of forms) {
		const full = formName(name, form);
		if (!/^\S+( \S+)*$/.test(full)) throw new Error(`/${full} is not words one space apart`);
		if (!form.description.trim()) throw new Error(`/${full} has no description`);
		if (typeof form.hint === "string" && !form.hint.trim()) throw new Error(`/${full} has a blank hint`);
		if (!unique(form.uses) || !unique(form.requires)) throw new Error(`/${full} repeats a field`);
		if (form.requires?.some((field) => !form.uses?.includes(field))) throw new Error(`/${full} requires a field it does not use`);
	}
}

/**
 * The form a command line names: the one with the most words that the
 * line's words after the name start with, matched exactly as the name is,
 * else the command's first form.
 */
function formOf<R>(forms: readonly CommandForm<R>[], words: readonly string[]): CommandForm<R> {
	let chosen: CommandForm<R> | undefined;
	let most = -1;
	for (const form of forms) {
		const own = form.words ? form.words.split(" ") : [];
		if (own.length > most && own.every((word, index) => words[index + 1] === word)) {
			chosen = form;
			most = own.length;
		}
	}
	return chosen ?? forms[0];
}

/** A form as listed, its hint for `runtime`, with its command's group. */
function listedForm<R>(name: string, group: CommandGroup, form: CommandForm<R>, runtime: R): ListedForm {
	const hint = typeof form.hint === "function" ? form.hint(runtime) : form.hint;
	return {
		name: formName(name, form), group, description: form.description,
		...(hint ? { hint } : {}),
		...(form.uses?.length ? { uses: [...form.uses] } : {}),
		...(form.requires?.length ? { requires: [...form.requires] } : {}),
	};
}

/** A form as `/help` and usage errors write it: `/emoji add :<name>:`. */
function formUsage(form: ListedForm): string {
	return `/${form.name}${form.hint ? ` ${form.hint}` : ""}`;
}

/** A command's usage: each of its forms, such as `/passkeys, or /passkeys remove <n>`. */
function formsUsage(forms: readonly ListedForm[]): string {
	const written = forms.map(formUsage);
	return written.length > 1 ? `${written.slice(0, -1).join(", ")}, or ${written[written.length - 1]}` : written[0];
}

/** Seals a spec into a Command: `bind` turns its parsed arguments into the handler call, checking the grants it needs. */
function seal<C extends ScopeBase, Args>(
	spec: SpecBase<C, Args>, audience: Audience, roles: readonly string[] | undefined, posting: boolean,
	bind: (args: Args) => (ctx: C, grants: Grants) => Promise<void> | void, audit?: (args: Args) => AuditDetails,
): Command<C> {
	checkForms(spec.name, spec.forms);
	const group = groupOf(audience, roles);
	const forms = (runtime: C["runtime"], identity?: CommandIdentity) => spec.forms
		.filter((form) => !identity || (form.offered?.(runtime, identity) ?? true))
		.map((form) => listedForm(spec.name, group, form, runtime));
	return Object.freeze({
		name: spec.name, formNames: Object.freeze(spec.forms.map((form) => formName(spec.name, form))), audience, group, ...(roles ? { roles } : {}), usageErrors: spec.usageErrors, posting,
		available: (runtime: C["runtime"]) => spec.available?.(runtime) ?? true,
		forms,
		usage: (runtime: C["runtime"]) => formsUsage(forms(runtime)),
		requiredBy: (words: readonly string[]) => {
			const form = formOf(spec.forms, words);
			return { name: formName(spec.name, form), requires: form.requires ?? [] };
		},
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
 * A runtime's commands, in the order `/help` and `ext:command_list` list
 * them: alphabetical, and so each command's forms, which the constructor
 * checks, with no name twice.
 */
export class CommandTable<C extends ScopeBase> {
	readonly commands: readonly Command<C>[];

	constructor(commands: readonly Command<C>[]) {
		for (let index = 1; index < commands.length; index++) {
			if (!(commands[index - 1].name < commands[index].name)) throw new Error(`Commands are listed alphabetically, each once: /${commands[index].name} is out of place`);
		}
		const forms = commands.flatMap((command) => command.formNames);
		for (let index = 1; index < forms.length; index++) {
			if (!(forms[index - 1] < forms[index])) throw new Error(`Forms are listed alphabetically, each once: /${forms[index]} is out of place`);
		}
		this.commands = Object.freeze([...commands]);
	}

	/** The command named `name` if this deployment offers it now; only its own availability is checked. */
	find(name: string, runtime: C["runtime"]): Command<C> | undefined {
		const command = this.commands.find((candidate) => candidate.name === name);
		return command?.available(runtime) ? command : undefined;
	}

	/**
	 * The commands offered now that the sender may run, as `/help` and
	 * `ext:command_list` list them: those for everyone (the `posting` ones
	 * only if they may post, `posts`), for registered users if they are one,
	 * for owners if they are one holding any roles the command needs, and
	 * every one for an admin; each with the forms offered to the sender
	 * (CommandForm.offered), and none left with no form.
	 */
	listFor(identity: CommandIdentity, runtime: C["runtime"], posts: boolean): OfferedCommand[] {
		const owner = isOwner(identity);
		const admin = isAdmin(identity);
		return this.commands.filter((command) => command.available(runtime) && (
			(command.audience === "everyone" && (posts || !command.posting)) ||
			(command.audience === "registered" && identity.tier === "registered") ||
			(command.audience === "owners" && owner && (!command.roles || command.roles.some((role) => holdsRole(identity, role)))) ||
			admin))
			.map((command) => ({ audience: command.audience, forms: command.forms(runtime, identity) }))
			.filter((command) => command.forms.length > 0);
	}
}

/** Builds a runtime's command table from its specs, made with helpers typed for its scope `C`. */
export function defineCommands<C extends ScopeBase>(build: (define: CommandHelpers<C>) => readonly Command<C>[]): CommandTable<C> {
	return new CommandTable(build(helpersFor<C>()));
}

/** Plain text as CommonMark text: `\`, `<`, `>` and `&` escaped, so a placeholder such as `<uses>` is not read as HTML. */
function markdownText(text: string): string {
	return text.replace(/[\\<>&]/g, "\\$&");
}

/** `/help`'s list: each form offered, its name and hint as code and its description, admins' marked "(admin-only)". */
export function helpText(commands: readonly OfferedCommand[]): string {
	return commands.flatMap((command) => command.forms.map((form) => `- \`${formUsage(form)}\`: ${markdownText(form.description)}${command.audience === "admins" ? " (admin-only)" : ""}`)).join("\n");
}

/** `ext:command_list`'s `commands`: each form offered, in their order. */
export function commandList(commands: readonly OfferedCommand[]): ListedForm[] {
	return commands.flatMap((command) => command.forms);
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
	/** Whether the request named its room (`room_id`), which a form that requires one needs. */
	readonly roomNamed: boolean;
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
 * up among those offered, by its exact name (an unknown one, `/Kick`
 * included, is an error to show, not a policy
 * violation, since people mistype); authorize (audience, roles, and for an
 * admin command, the capability); refuse a form that requires `room_id`
 * sent without one, an error to show like an unknown command; refuse a
 * live text embed; parse; run.
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
	// Names are case-sensitive (ext:command_list): `/Kick` is not `/kick`.
	const name = words[0];
	const command = table.find(name, ctx.runtime);
	if (!command) {
		const message = line.startsWith("/") ? `Unknown command /${name}; try /help` : "A command starts with /; try /help";
		host.fail({ name: "invalid_params", message: message.slice(0, 200) });
		return;
	}
	const grants = authorize(command, identity, host);
	let details: AuditDetails = {};
	// A form that acts only on a room the client names is not run in the default room.
	const required = command.requiredBy(words);
	if (required.requires.includes("room_id") && !host.roomNamed) {
		grants.admin?.settle("failed", details, "invalid_params");
		host.fail({ name: "invalid_params", message: `Send /${required.name} from a room, with its room_id` });
		return;
	}
	// Live text starts with its own commands, or in a message (§4.8.3).
	if (hasLiveEmbed(body)) {
		grants.admin?.settle("failed", details, "invalid_params");
		throw { name: "invalid_params", message: "A terminal or append embed goes in a message; or use /embed-terminal or /embed-append" } satisfies ProtocolError;
	}
	try {
		const prepared = command.prepare({ text, line, words, body, usage: command.usage(ctx.runtime) }, ctx.runtime);
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
