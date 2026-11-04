import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { handleGitBranch } from "./branch.ts";
import { handleGitCleanup } from "./cleanup.ts";
import { handleGitFetch } from "./fetch.ts";
import { handleGitPull } from "./pull.ts";
import { handleGitPush } from "./push.ts";
import { handleGitStatus } from "./status.ts";

export type Subcommand = {
	name: string;
	/** Shown in the usage text, e.g. "branch [name]". */
	usage: string;
	description: string;
	/** Whether the subcommand accepts an argument; autocomplete then appends a space. */
	takesArgument: boolean;
	run(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void>;
};

export const SUBCOMMANDS: Subcommand[] = [
	{
		name: "status",
		usage: "status",
		description: "Show staged, unstaged and untracked files",
		takesArgument: false,
		run: (pi, ctx) => handleGitStatus(pi, ctx),
	},
	{
		name: "fetch",
		usage: "fetch",
		description: "Run git fetch --all --prune",
		takesArgument: false,
		run: (pi, ctx) => handleGitFetch(pi, ctx),
	},
	{
		name: "pull",
		usage: "pull",
		description: "Run git pull --prune",
		takesArgument: false,
		run: (pi, ctx) => handleGitPull(pi, ctx),
	},
	{
		name: "push",
		usage: "push",
		description: "Push the current branch, setting its upstream if needed",
		takesArgument: false,
		run: (pi, ctx) => handleGitPush(pi, ctx),
	},
	{
		name: "branch",
		usage: "branch [name]",
		description: "List, switch or create branches",
		takesArgument: true,
		run: (pi, ctx, args) => handleGitBranch(pi, ctx, args),
	},
	{
		name: "cleanup",
		usage: "cleanup",
		description: "Delete merged branches and branches whose upstream is gone",
		takesArgument: false,
		run: (pi, ctx) => handleGitCleanup(pi, ctx),
	},
];

export const USAGE = `Usage: ${SUBCOMMANDS.map((x) => `/git ${x.usage}`).join(" | ")}`;

export function findSubcommand(name: string): Subcommand | undefined {
	return SUBCOMMANDS.find((x) => x.name === name);
}
