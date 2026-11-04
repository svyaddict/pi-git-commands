import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { createGitAutocompleteProvider } from "../extensions/autocomplete.ts";
import type { BranchListing } from "../extensions/git.ts";

const listing: BranchListing = {
	locals: [
		{ name: "main", isCurrent: true, isLocalOnly: false },
		{ name: "feature/login", isCurrent: false, isLocalOnly: true },
	],
	remoteOnly: [{ name: "release/1.0", remotes: ["origin", "upstream"] }],
};

const FALLBACK = { items: [{ value: "fallback", label: "fallback" }], prefix: "" };

function setup() {
	const delegated: string[] = [];
	const current = {
		async getSuggestions(lines: string[]) {
			delegated.push(lines[0] ?? "");
			return FALLBACK;
		},
		applyCompletion() {
			throw new Error("not used");
		},
		shouldTriggerFileCompletion() {
			return true;
		},
	} as unknown as AutocompleteProvider;
	const provider = createGitAutocompleteProvider(current, async () => listing);
	const suggest = (text: string) =>
		provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal } as never);
	return { provider, suggest, delegated };
}

describe("autocomplete", () => {
	it("suggests subcommands, with a trailing space only for those taking an argument", async () => {
		const { suggest } = setup();
		const result = await suggest("/git ");
		assert.deepEqual(
			result?.items.map((x) => x.value),
			["status", "fetch", "pull", "push", "branch ", "cleanup", "footer "],
		);
		const filtered = await suggest("/git pu");
		assert.deepEqual(
			filtered?.items.map((x) => x.label),
			["pull", "push"],
		);
		assert.equal(filtered?.prefix, "pu");
	});

	it("suggests local branches first, then remote-only ones", async () => {
		const { suggest } = setup();
		const result = await suggest("/git branch ");
		assert.deepEqual(
			result?.items.map((x) => [x.value, x.description]),
			[
				["main", "current branch"],
				["feature/login", "local only"],
				["release/1.0", "remote only (origin, upstream)"],
			],
		);
		const filtered = await suggest("/git branch LOG");
		assert.deepEqual(
			filtered?.items.map((x) => x.value),
			["feature/login"],
		);
		assert.equal(filtered?.prefix, "LOG");
	});

	it("suggests fixed argument values such as /git footer on|off", async () => {
		const { suggest } = setup();
		const result = await suggest("/git footer ");
		assert.deepEqual(
			result?.items.map((x) => x.value),
			["on", "off"],
		);
		const filtered = await suggest("/git footer OF");
		assert.deepEqual(
			filtered?.items.map((x) => x.value),
			["off"],
		);
		assert.equal(filtered?.prefix, "OF");
		// Subcommands without fixed values leave arguments to the built-in provider.
		assert.equal(await suggest("/git status x"), FALLBACK);
	});

	it("leaves other input, including /github, to the built-in provider", async () => {
		const { suggest, delegated, provider } = setup();
		assert.equal(await suggest("/github"), FALLBACK);
		assert.equal(await suggest("hello /git "), FALLBACK);
		assert.equal(await suggest("/git branch main extra"), FALLBACK);
		assert.equal(await suggest("/git nothing-matches"), FALLBACK);
		assert.deepEqual(delegated, ["/github", "hello /git ", "/git branch main extra", "/git nothing-matches"]);

		assert.equal(provider.shouldTriggerFileCompletion?.(["/git branch "], 0, 12), false);
		assert.equal(provider.shouldTriggerFileCompletion?.(["/github "], 0, 8), true);
	});
});
