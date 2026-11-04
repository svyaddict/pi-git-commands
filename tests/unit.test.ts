import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBranchList } from "../extensions/commands/branch.ts";
import { describePullFailure, summarizePullOutput } from "../extensions/commands/pull.ts";
import { describePushFailure } from "../extensions/commands/push.ts";
import { findSubcommand, USAGE } from "../extensions/commands/registry.ts";
import { plural } from "../extensions/commands/shared.ts";
import { formatStatus, parseStatus } from "../extensions/commands/status.ts";
import type { GitExecResult } from "../extensions/git.ts";
import {
	describeFailure,
	gitEnvironment,
	groupRemoteRefs,
	parseLeftRightCount,
	splitLines,
	splitRemoteRef,
} from "../extensions/git.ts";
import { formatTokens } from "../extensions/usage.ts";

const failure = (stderr: string, extra: Partial<GitExecResult> = {}): GitExecResult => ({
	code: 1,
	stdout: "",
	stderr,
	killed: false,
	...extra,
});

describe("git helpers", () => {
	it("splitRemoteRef matches the longest remote, so remotes may contain slashes", () => {
		assert.deepEqual(splitRemoteRef("origin/feature/x", ["origin"]), { remote: "origin", branch: "feature/x" });
		assert.deepEqual(splitRemoteRef("team/a/main", ["team", "team/a"]), { remote: "team/a", branch: "main" });
		assert.equal(splitRemoteRef("origin/HEAD", ["origin"]), undefined);
		assert.equal(splitRemoteRef("unknown/main", ["origin"]), undefined);
		assert.equal(splitRemoteRef("origin/", ["origin"]), undefined);
	});

	it("groupRemoteRefs lists every remote that has a branch", () => {
		const grouped = groupRemoteRefs(
			["origin/main", "upstream/main", "origin/feat", "origin/HEAD"],
			["origin", "upstream"],
		);
		assert.deepEqual(Object.fromEntries(grouped), { main: ["origin", "upstream"], feat: ["origin"] });
	});

	it("parseLeftRightCount reads incoming then outgoing", () => {
		assert.deepEqual(parseLeftRightCount("3\t1\n"), { incoming: 3, outgoing: 1, available: true });
		assert.deepEqual(parseLeftRightCount("garbage"), { incoming: 0, outgoing: 0, available: true });
	});

	it("splitLines drops blank lines and surrounding whitespace", () => {
		assert.deepEqual(splitLines("  a \r\n\n b\n"), ["a", "b"]);
	});

	it("gitEnvironment forbids prompts and fixes the message language, keeping the rest", () => {
		const env = gitEnvironment({ PATH: "/bin", GIT_TERMINAL_PROMPT: "1", LC_ALL: "it_IT.UTF-8" });
		assert.equal(env.PATH, "/bin");
		assert.equal(env.GIT_TERMINAL_PROMPT, "0");
		assert.equal(env.GCM_INTERACTIVE, "never");
		assert.equal(env.LC_ALL, "C");
	});

	it("describeFailure reports timeouts, stderr or the exit code", () => {
		assert.equal(describeFailure(failure("", { killed: true }), 120_000), "timed out after 120s");
		assert.equal(describeFailure(failure("  fatal: nope \n")), "fatal: nope");
		assert.equal(describeFailure(failure("", { code: 128 })), "exit code 128");
	});
});

describe("status parsing", () => {
	const nul = (...entries: string[]) => `${entries.join("\0")}\0`;
	const hashes = "100644 100644 100644 1111111 2222222";

	it("parses branch headers and every entry kind", () => {
		const output = nul(
			"# branch.oid 0123456789abcdef0123456789abcdef01234567",
			"# branch.head feature/x",
			"# branch.upstream origin/feature/x",
			"# branch.ab +2 -1",
			`1 M. N... ${hashes} src/a file.ts`,
			`1 .M N... ${hashes} README.md`,
			`1 MM N... ${hashes} both.ts`,
			`2 R. N... ${hashes} R100 new name.ts`,
			"old name.ts",
			"u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 conflict.ts",
			"? notes with spaces.txt",
		);
		const status = parseStatus(output);
		assert.equal(status.branch, "feature/x");
		assert.equal(status.oid, "0123456");
		assert.equal(status.upstream, "origin/feature/x");
		assert.deepEqual(status.staged, [
			{ code: "M", path: "src/a file.ts" },
			{ code: "M", path: "both.ts" },
			{ code: "R", path: "old name.ts → new name.ts" },
		]);
		assert.deepEqual(status.unstaged, [
			{ code: "M", path: "README.md" },
			{ code: "M", path: "both.ts" },
		]);
		assert.deepEqual(status.conflicts, [{ code: "UU", path: "conflict.ts" }]);
		assert.deepEqual(status.untracked, ["notes with spaces.txt"]);
	});

	it("reports a detached HEAD by commit", () => {
		const status = parseStatus(nul("# branch.oid abcdef0123456789", "# branch.head (detached)"));
		assert.equal(status.branch, undefined);
		assert.match(formatStatus(status, { incoming: 0, outgoing: 0, available: false }), /^HEAD detached at abcdef0/);
	});

	it("formats a clean tree and truncates long sections", () => {
		const sync = { incoming: 1, outgoing: 2, available: true };
		assert.equal(
			formatStatus(parseStatus(nul("# branch.head main")), sync),
			"On branch main (no upstream) ↓1 ↑2\nWorking tree clean.",
		);

		const many = Array.from({ length: 20 }, (_, i) => `? file${i}.txt`);
		const text = formatStatus(parseStatus(nul("# branch.head main", ...many)), sync);
		assert.match(text, /^Untracked \(20\):$/m);
		assert.match(text, /… and 5 more$/);
	});
});

describe("command messages", () => {
	it("summarizes pull output", () => {
		assert.equal(summarizePullOutput(""), "Update completed.");
		assert.equal(summarizePullOutput("Already up to date.\n"), "Already up to date.");
		assert.equal(
			summarizePullOutput("Updating a..b\nFast-forward\n a | 1 +\n 1 file changed\n"),
			"Updating a..b … 1 file changed",
		);
	});

	it("explains a diverged pull instead of showing git's hints", () => {
		const message = describePullFailure(
			failure(
				"hint: Diverging branches can't be fast-forwarded\nhint: ...\nfatal: Not possible to fast-forward, aborting.\n",
			),
		);
		assert.match(message, /diverged/);
		assert.match(message, /Nothing was changed/);
	});

	it("drops fetch progress from other pull errors", () => {
		const message = describePullFailure(
			failure("From /tmp/remote\n   a..b  main -> origin/main\nerror: Your local changes would be overwritten\n"),
		);
		assert.equal(message, "error: Your local changes would be overwritten");
	});

	it("explains rejected pushes and trims hints from other errors", () => {
		assert.match(describePushFailure(failure(" ! [rejected]  main -> main (fetch first)\n")), /Run \/git pull first/);
		assert.equal(
			describePushFailure(failure("To /tmp/remote\nremote: protected branch\nhint: long advice\n")),
			"remote: protected branch",
		);
	});

	it("lists branches with current and local-only markers", () => {
		const text = formatBranchList([
			{ name: "main", isCurrent: true, isLocalOnly: false },
			{ name: "wip", isCurrent: false, isLocalOnly: true },
		]);
		assert.match(text, /^> main$/m);
		assert.match(text, /^ {2}wip\*$/m);
		assert.equal(formatBranchList([]), "No local branches found.");
	});

	it("pluralizes", () => {
		assert.equal(plural(1, "commit"), "1 commit");
		assert.equal(plural(2, "commit"), "2 commits");
		assert.equal(plural(2, "branch", "branches"), "2 branches");
	});

	it("finds subcommands and lists them in the usage", () => {
		assert.equal(findSubcommand("pull")?.name, "pull");
		assert.equal(findSubcommand("pul"), undefined);
		for (const name of ["status", "fetch", "pull", "push", "branch", "cleanup", "footer"]) {
			assert.ok(USAGE.includes(`/git ${name}`), name);
		}
	});
});

describe("footer", () => {
	it("formats token counts", () => {
		assert.equal(formatTokens(999), "999");
		assert.equal(formatTokens(1234), "1.2k");
		assert.equal(formatTokens(45_600), "46k");
		assert.equal(formatTokens(3_400_000), "3.4M");
		assert.equal(formatTokens(12_000_000), "12M");
	});
});
