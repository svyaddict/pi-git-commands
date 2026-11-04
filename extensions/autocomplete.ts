import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { SUBCOMMANDS } from "./commands/registry.ts";
import type { BranchListing } from "./git.ts";

function makeBranchItems(listing: BranchListing, query: string): AutocompleteItem[] {
	const q = query.trim().toLowerCase();
	const matches = (name: string) => !q || name.toLowerCase().includes(q);

	const localItems: AutocompleteItem[] = listing.locals
		.filter((b) => matches(b.name))
		.map((branch) => ({
			value: branch.name,
			label: `${branch.name}${branch.isLocalOnly ? "*" : ""}`,
			description: branch.isCurrent ? "current branch" : branch.isLocalOnly ? "local only" : "present on remote",
		}));

	const remoteItems: AutocompleteItem[] = listing.remoteOnly
		.filter((b) => matches(b.name))
		.map((branch) => ({
			value: branch.name,
			label: branch.name,
			description: `remote only (${branch.remotes.join(", ")})`,
		}));

	return [...localItems, ...remoteItems].slice(0, 50);
}

function makeSubcommandItems(token: string): AutocompleteItem[] {
	return SUBCOMMANDS.filter((x) => x.name.startsWith(token)).map((x) => ({
		// Trailing space: completing it leads straight into argument suggestions.
		value: x.takesArgument ? `${x.name} ` : x.name,
		label: x.name,
		description: x.description,
	}));
}

function makeChoiceItems(subcommand: string, token: string): AutocompleteItem[] {
	const choices = SUBCOMMANDS.find((x) => x.name === subcommand)?.choices ?? [];
	const q = token.toLowerCase();
	return choices
		.filter((x) => x.value.startsWith(q))
		.map((x) => ({ value: x.value, label: x.value, description: x.description }));
}

function isGitCommandInput(text: string): boolean {
	return /^\/git(?:\s|$)/.test(text);
}

export function createGitAutocompleteProvider(
	current: AutocompleteProvider,
	getBranches: () => Promise<BranchListing>,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const line = lines[cursorLine] ?? "";
			const textBeforeCursor = line.slice(0, cursorCol);

			if (!isGitCommandInput(textBeforeCursor)) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const branchMatch = textBeforeCursor.match(/^\/git\s+branch\s+(\S*)$/);
			if (branchMatch) {
				const token = branchMatch[1] ?? "";
				const listing = await getBranches();
				if (options.signal.aborted) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}

				const items = makeBranchItems(listing, token);
				if (items.length === 0) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}

				return {
					items,
					prefix: token,
				};
			}

			const argumentMatch = textBeforeCursor.match(/^\/git\s+(\S+)\s+(\S*)$/);
			if (argumentMatch) {
				const token = argumentMatch[2] ?? "";
				const items = makeChoiceItems(argumentMatch[1] ?? "", token);
				if (items.length > 0) {
					return { items, prefix: token };
				}
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const subcommandMatch = textBeforeCursor.match(/^\/git\s+(\S*)$/);
			if (subcommandMatch) {
				const token = subcommandMatch[1] ?? "";
				const items = makeSubcommandItems(token);
				if (items.length === 0) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}

				return {
					items,
					prefix: token,
				};
			}

			return current.getSuggestions(lines, cursorLine, cursorCol, options);
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			const line = lines[cursorLine] ?? "";
			const textBeforeCursor = line.slice(0, cursorCol);
			if (isGitCommandInput(textBeforeCursor)) {
				return false;
			}
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}
