import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createGitAutocompleteProvider } from "./autocomplete.ts";
import type { CommandServices } from "./commands/registry.ts";
import { findSubcommand, SUBCOMMANDS, USAGE } from "./commands/registry.ts";
import { createFooterController } from "./footer.ts";
import type { BranchListing } from "./git.ts";
import { GitError, getRepositoryState, listBranches } from "./git.ts";
import { defaultSettingsPath } from "./settings.ts";

const BRANCH_CACHE_MS = 2_000;

export default function (pi: ExtensionAPI): void {
	const services: CommandServices = { footer: createFooterController(defaultSettingsPath()) };

	pi.on("session_start", async (_event, ctx) => {
		let cache: { at: number; listing: BranchListing } | undefined;
		const getBranches = async (): Promise<BranchListing> => {
			const now = Date.now();
			if (cache && now - cache.at < BRANCH_CACHE_MS) {
				return cache.listing;
			}
			// Suggestions are best effort: outside a repository or on failure offer none (and do
			// not cache the failure).
			try {
				const listing = await listBranches(ctx.cwd);
				cache = { at: now, listing };
				return listing;
			} catch {
				return { locals: [], remoteOnly: [] };
			}
		};

		ctx.ui.addAutocompleteProvider((current) => createGitAutocompleteProvider(current, getBranches));
		await services.footer.start(ctx);
	});

	pi.registerCommand("git", {
		description: `Git helper: ${SUBCOMMANDS.map((x) => `/git ${x.usage}`).join(" | ")}`,
		handler: (args, ctx) => runGitCommand(ctx, args, services),
	});
}

function describeError(error: unknown): string {
	if (error instanceof GitError) {
		return error.message;
	}
	return `unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

/** Checks that git is available and `cwd` is a repository; notifies and returns false otherwise. */
async function ensureRepository(ctx: ExtensionCommandContext): Promise<boolean> {
	try {
		const state = await getRepositoryState(ctx.cwd);
		if (state === "git-missing") {
			ctx.ui.notify("git was not found. Install git and make sure it is on your PATH.", "error");
			return false;
		}
		if (state === "not-repository") {
			ctx.ui.notify("The current directory is not a git repository.", "error");
			return false;
		}
		return true;
	} catch (error) {
		ctx.ui.notify(`/git: ${describeError(error)}`, "error");
		return false;
	}
}

/**
 * Dispatch `/git <args>`. Every outcome, including git failures and unexpected errors, ends
 * in a notification. After a subcommand runs, whatever its outcome, the footer counters are
 * refreshed.
 */
export async function runGitCommand(
	ctx: ExtensionCommandContext,
	args: string,
	services: CommandServices,
): Promise<void> {
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
	if (subcommand.requiresRepository !== false && !(await ensureRepository(ctx))) {
		return;
	}

	try {
		await subcommand.run(ctx, rest, services);
	} catch (error) {
		ctx.ui.notify(`/git ${subcommand.name}: ${describeError(error)}`, "error");
	} finally {
		services.footer.refresh();
	}
}
