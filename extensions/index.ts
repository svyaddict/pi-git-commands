import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createGitAutocompleteProvider } from "./autocomplete.ts";
import { findSubcommand, SUBCOMMANDS, USAGE } from "./commands/registry.ts";
import { installGitFooter, isFooterDisabled } from "./footer.ts";
import type { BranchListing } from "./git.ts";
import { GitError, getRepositoryState, isGitRepository, listBranches } from "./git.ts";

const BRANCH_CACHE_MS = 2_000;

export default function (pi: ExtensionAPI): void {
	/** Set by the footer while it is mounted, so commands can refresh the counters right away. */
	let requestSyncRefresh: (() => void) | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (!(await isGitRepository(ctx.cwd))) {
			return;
		}

		let cache: { at: number; listing: BranchListing } | undefined;
		const getBranches = async (): Promise<BranchListing> => {
			const now = Date.now();
			if (cache && now - cache.at < BRANCH_CACHE_MS) {
				return cache.listing;
			}
			// Suggestions are best effort: on failure offer none (and do not cache the failure).
			try {
				const listing = await listBranches(ctx.cwd);
				cache = { at: now, listing };
				return listing;
			} catch {
				return { locals: [], remoteOnly: [] };
			}
		};

		ctx.ui.addAutocompleteProvider((current) => createGitAutocompleteProvider(current, getBranches));

		if (ctx.mode !== "tui" || isFooterDisabled()) {
			return;
		}

		installGitFooter(ctx, (refresh) => {
			requestSyncRefresh = refresh;
		});
	});

	pi.registerCommand("git", {
		description: `Git helper: ${SUBCOMMANDS.map((x) => `/git ${x.usage}`).join(" | ")}`,
		handler: (args, ctx) => runGitCommand(ctx, args, () => requestSyncRefresh?.()),
	});
}

function describeError(error: unknown): string {
	if (error instanceof GitError) {
		return error.message;
	}
	return `unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Dispatch `/git <args>`. Every outcome, including git failures and unexpected errors, ends
 * in a notification; `afterRun` is called once a subcommand has run, whatever its outcome.
 */
export async function runGitCommand(ctx: ExtensionCommandContext, args: string, afterRun?: () => void): Promise<void> {
	try {
		const state = await getRepositoryState(ctx.cwd);
		if (state === "git-missing") {
			ctx.ui.notify("git was not found. Install git and make sure it is on your PATH.", "error");
			return;
		}
		if (state === "not-repository") {
			ctx.ui.notify("The current directory is not a git repository.", "error");
			return;
		}
	} catch (error) {
		ctx.ui.notify(`/git: ${describeError(error)}`, "error");
		return;
	}

	const trimmed = args.trim();
	if (!trimmed) {
		ctx.ui.notify(USAGE, "info");
		return;
	}

	const [, name = "", rest = ""] = trimmed.match(/^(\S+)\s*(.*)$/) ?? [];
	const subcommand = findSubcommand(name);
	if (!subcommand) {
		ctx.ui.notify(`Unknown command '${name}'. ${USAGE}`, "error");
		return;
	}
	if (!subcommand.takesArgument && rest) {
		ctx.ui.notify(`/git ${subcommand.name} takes no arguments.`, "error");
		return;
	}

	try {
		await subcommand.run(ctx, rest);
	} catch (error) {
		ctx.ui.notify(`/git ${subcommand.name}: ${describeError(error)}`, "error");
	} finally {
		afterRun?.();
	}
}
