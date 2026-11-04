import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGitAutocompleteProvider } from "./autocomplete.ts";
import { findSubcommand, SUBCOMMANDS, USAGE } from "./commands/registry.ts";
import { installGitFooter, isFooterDisabled } from "./footer.ts";
import type { BranchListing } from "./git.ts";
import { isGitRepository, listBranches } from "./git.ts";

const BRANCH_CACHE_MS = 2_000;

export default function (pi: ExtensionAPI): void {
	/** Set by the footer while it is mounted, so commands can refresh the counters right away. */
	let requestSyncRefresh: (() => void) | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (!(await isGitRepository(pi, ctx.cwd))) {
			return;
		}

		let cache: { at: number; listing: BranchListing } | undefined;
		const getBranches = async (): Promise<BranchListing> => {
			const now = Date.now();
			if (cache && now - cache.at < BRANCH_CACHE_MS) {
				return cache.listing;
			}
			const listing = await listBranches(pi, ctx.cwd);
			cache = { at: now, listing };
			return listing;
		};

		ctx.ui.addAutocompleteProvider((current) => createGitAutocompleteProvider(current, getBranches));

		if (ctx.mode !== "tui" || isFooterDisabled()) {
			return;
		}

		installGitFooter(pi, ctx, (refresh) => {
			requestSyncRefresh = refresh;
		});
	});

	pi.registerCommand("git", {
		description: `Git helper: ${SUBCOMMANDS.map((x) => `/git ${x.usage}`).join(" | ")}`,
		handler: async (args, ctx) => {
			if (!(await isGitRepository(pi, ctx.cwd))) {
				ctx.ui.notify("The current directory is not a git repository.", "error");
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

			await subcommand.run(pi, ctx, rest);
			requestSyncRefresh?.();
		},
	});
}
