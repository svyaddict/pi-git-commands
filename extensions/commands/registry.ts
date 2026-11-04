import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { FooterController } from "../footer.ts";
import { handleGitBranch } from "./branch.ts";
import { handleGitCleanup } from "./cleanup.ts";
import { handleGitFetch } from "./fetch.ts";
import { handleGitFooter } from "./footer.ts";
import { handleGitPull } from "./pull.ts";
import { handleGitPush } from "./push.ts";
import { handleGitStatus } from "./status.ts";

/** Session-scoped services that some subcommands need. */
export type CommandServices = {
	footer: FooterController;
};

export type Choice = {
	value: string;
	description: string;
};

export type Subcommand = {
	name: string;
	/** Shown in the usage text, e.g. "branch [name]". */
	usage: string;
	description: string;
	/** Whether the subcommand accepts an argument; autocomplete then appends a space. */
	takesArgument: boolean;
	/** Fixed argument values, suggested by autocomplete. */
	choices?: Choice[];
	/** Defaults to true: the subcommand only makes sense inside a git working tree. */
	requiresRepository?: boolean;
	run(ctx: ExtensionCommandContext, args: string, services: CommandServices): Promise<void>;
};

export const SUBCOMMANDS: Subcommand[] = [
	{
		name: "status",
		usage: "status",
		description: "Show staged, unstaged and untracked files",
		takesArgument: false,
		run: (ctx) => handleGitStatus(ctx),
	},
	{
		name: "fetch",
		usage: "fetch",
		description: "Run git fetch --all --prune",
		takesArgument: false,
		run: (ctx) => handleGitFetch(ctx),
	},
	{
		name: "pull",
		usage: "pull",
		description: "Fast-forward the current branch (git pull --ff-only --prune)",
		takesArgument: false,
		run: (ctx) => handleGitPull(ctx),
	},
	{
		name: "push",
		usage: "push",
		description: "Push the current branch, setting its upstream if needed",
		takesArgument: false,
		run: (ctx) => handleGitPush(ctx),
	},
	{
		name: "branch",
		usage: "branch [name]",
		description: "List, switch or create branches",
		takesArgument: true,
		run: (ctx, args) => handleGitBranch(ctx, args),
	},
	{
		name: "cleanup",
		usage: "cleanup",
		description: "Delete merged branches and branches whose upstream is gone",
		takesArgument: false,
		run: (ctx) => handleGitCleanup(ctx),
	},
	{
		name: "footer",
		usage: "footer [on|off]",
		description: "Show or change the git footer, for every pi session",
		takesArgument: true,
		choices: [
			{ value: "on", description: "Show the git footer" },
			{ value: "off", description: "Use pi's built-in footer" },
		],
		requiresRepository: false,
		run: (ctx, args, services) => handleGitFooter(ctx, args, services.footer),
	},
];

export const USAGE = `Usage: ${SUBCOMMANDS.map((x) => `/git ${x.usage}`).join(" | ")}`;

export function findSubcommand(name: string): Subcommand | undefined {
	return SUBCOMMANDS.find((x) => x.name === name);
}
