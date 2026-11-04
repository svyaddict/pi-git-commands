import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { handleGitBranch } from "../extensions/commands/branch.ts";
import { handleGitCleanup } from "../extensions/commands/cleanup.ts";
import { handleGitFetch } from "../extensions/commands/fetch.ts";
import { handleGitPull } from "../extensions/commands/pull.ts";
import { handleGitPush } from "../extensions/commands/push.ts";
import { handleGitStatus } from "../extensions/commands/status.ts";
import {
	GitError,
	getAheadBehind,
	getCurrentBranch,
	getRepositoryState,
	getUpstream,
	listBranches,
	localBranchExists,
	runGit,
	validateBranchName,
} from "../extensions/git.ts";
import { runGitCommand } from "../extensions/index.ts";
import { commit, createFixture, fakeContext, git, tempDir, testServices } from "./helpers.ts";

describe("runGit", { concurrency: true }, () => {
	it("passes the non-interactive environment to git", async () => {
		const dir = tempDir();
		// Shell aliases run through sh, which ships with git on every platform.
		const result = await runGit(dir, [
			"-c",
			"alias.env-check=!echo $GIT_TERMINAL_PROMPT:$GCM_INTERACTIVE",
			"env-check",
		]);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stdout.trim(), "0:never");
	});

	it("terminates git and its child processes on timeout", async () => {
		const dir = tempDir();
		const started = Date.now();
		// If only git were killed, the surviving sleep would keep the pipes open for 10 s.
		const result = await runGit(dir, ["-c", "alias.wait=!sleep 10", "wait"], 300);
		assert.equal(result.killed, true);
		assert.notEqual(result.code, 0);
		assert.ok(Date.now() - started < 6_000, `took ${Date.now() - started} ms`);
	});

	it("tells repositories apart from plain directories", async () => {
		const { repo } = await createFixture();
		assert.equal(await getRepositoryState(repo), "repository");
		assert.equal(await getRepositoryState(tempDir()), "not-repository");
	});

	it("validates branch names through git", async () => {
		const { repo } = await createFixture();
		assert.deepEqual(await validateBranchName(repo, "feature/ok"), { name: "feature/ok" });
		assert.ok("error" in (await validateBranchName(repo, "bad..name")));
		assert.ok("error" in (await validateBranchName(repo, "-x")));
		assert.ok("error" in (await validateBranchName(repo, "has space")));
	});
});

describe("getUpstream", { concurrency: true }, () => {
	it("returns the configured upstream, even when it was deleted on the remote", async () => {
		const { repo } = await createFixture();
		assert.equal(await getUpstream(repo, "main"), "origin/main");
		await git(repo, "switch", "-q", "-c", "gone");
		await git(repo, "push", "-q", "-u", "origin", "gone");
		await git(repo, "push", "-q", "origin", ":gone");
		await git(repo, "fetch", "-q", "--prune");
		assert.equal(await getUpstream(repo, "gone"), "origin/gone");
	});

	it("returns undefined when no upstream is configured", async () => {
		const { repo } = await createFixture();
		await git(repo, "branch", "local");
		assert.equal(await getUpstream(repo, "local"), undefined);
	});

	it("throws when git fails instead of reporting a missing upstream", async () => {
		await assert.rejects(getUpstream(tempDir(), "main"), GitError);
	});
});

describe("ahead/behind counters", { concurrency: true }, () => {
	it("compares with the upstream", async () => {
		const { repo, cloneAnother } = await createFixture();
		const other = await cloneAnother();
		await commit(other, "theirs.txt");
		await git(other, "push", "-q");
		await commit(repo, "mine.txt");
		await git(repo, "fetch", "-q");
		assert.deepEqual(await getAheadBehind(repo), { incoming: 1, outgoing: 1, available: true });
	});

	it("counts unpushed commits on a branch that was never pushed", async () => {
		const { repo } = await createFixture();
		await git(repo, "switch", "-q", "-c", "local");
		await commit(repo, "a.txt");
		await commit(repo, "b.txt");
		assert.deepEqual(await getAheadBehind(repo), { incoming: 0, outgoing: 2, available: true });
	});
});

describe("/git status and /git fetch", { concurrency: true }, () => {
	it("summarizes the working tree", async () => {
		const { repo } = await createFixture();
		writeFileSync(join(repo, "README.md"), "changed\n");
		writeFileSync(join(repo, "new file.txt"), "x");
		const { ctx, lastMessage } = fakeContext(repo);
		await handleGitStatus(ctx);
		assert.match(lastMessage(), /^On branch main → origin\/main ↓0 ↑0$/m);
		assert.match(lastMessage(), /^Not staged \(1\):\n {2}M {2}README\.md$/m);
		assert.match(lastMessage(), /^Untracked \(1\):\n {2}new file\.txt$/m);
	});

	it("reports incoming commits after fetching", async () => {
		const { repo, cloneAnother } = await createFixture();
		const other = await cloneAnother();
		await commit(other, "theirs.txt");
		await git(other, "push", "-q");
		const { ctx, lastMessage } = fakeContext(repo);
		await handleGitFetch(ctx);
		assert.match(lastMessage(), /'main' is 1 commit behind/);
	});
});

describe("/git pull", { concurrency: true }, () => {
	it("fast-forwards the current branch", async () => {
		const { repo, cloneAnother } = await createFixture();
		const other = await cloneAnother();
		const theirs = await commit(other, "theirs.txt");
		await git(other, "push", "-q");
		const { ctx, notifications } = fakeContext(repo);
		await handleGitPull(ctx);
		assert.equal(notifications.at(-1)?.level, "info", notifications.at(-1)?.message);
		assert.equal(await git(repo, "rev-parse", "HEAD"), theirs);
	});

	for (const rebase of ["false", "true"]) {
		it(`never merges or rebases diverged branches (pull.rebase=${rebase})`, async () => {
			const { repo, cloneAnother } = await createFixture();
			// Without pull.rebase git refuses diverged pulls by itself; with it, a plain pull would merge or rebase.
			await git(repo, "config", "pull.rebase", rebase);
			const other = await cloneAnother();
			await commit(other, "theirs.txt");
			await git(other, "push", "-q");
			const mine = await commit(repo, "mine.txt");
			const { ctx, notifications } = fakeContext(repo);
			await handleGitPull(ctx);
			assert.equal(notifications.at(-1)?.level, "error");
			assert.match(notifications.at(-1)?.message ?? "", /diverged/);
			assert.equal(await git(repo, "rev-parse", "HEAD"), mine);
			assert.equal(await git(repo, "status", "--porcelain"), "");
		});
	}

	it("offers to track a same-named remote branch when there is no upstream", async () => {
		const { repo, cloneAnother } = await createFixture();
		const other = await cloneAnother();
		await git(other, "switch", "-q", "-c", "shared");
		const theirs = await commit(other, "shared.txt");
		await git(other, "push", "-q", "-u", "origin", "shared");
		await git(repo, "switch", "-q", "-c", "shared");
		const { ctx, prompts } = fakeContext(repo, [true]);
		await handleGitPull(ctx);
		assert.match(prompts[0] ?? "", /Set it to 'origin\/shared'/);
		assert.equal(await git(repo, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/shared");
		assert.equal(await git(repo, "rev-parse", "HEAD"), theirs);
	});

	it("explains that a never-pushed branch has nothing to pull", async () => {
		const { repo } = await createFixture();
		await git(repo, "switch", "-q", "-c", "local");
		const { ctx, lastMessage } = fakeContext(repo);
		await handleGitPull(ctx);
		assert.match(lastMessage(), /does not exist on any remote/);
	});
});

describe("/git push", { concurrency: true }, () => {
	it("sets the upstream of a new branch after confirmation", async () => {
		const { repo, remote } = await createFixture();
		await git(repo, "switch", "-q", "-c", "feature");
		const mine = await commit(repo, "feature.txt");
		const { ctx, lastMessage } = fakeContext(repo, [true]);
		await handleGitPush(ctx);
		assert.equal(lastMessage(), "Pushed 'feature' to 'origin/feature'.");
		assert.equal(await git(remote, "rev-parse", "feature"), mine);
		assert.equal(await git(repo, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/feature");
	});

	it("does nothing when declined", async () => {
		const { repo, remote } = await createFixture();
		await git(repo, "switch", "-q", "-c", "feature");
		const { ctx, lastMessage } = fakeContext(repo, [false]);
		await handleGitPush(ctx);
		assert.equal(lastMessage(), "Operation cancelled.");
		await assert.rejects(git(remote, "rev-parse", "--verify", "feature"));
	});

	it("explains a rejected push", async () => {
		const { repo, cloneAnother } = await createFixture();
		const other = await cloneAnother();
		await commit(other, "theirs.txt");
		await git(other, "push", "-q");
		await commit(repo, "mine.txt");
		const { ctx, notifications } = fakeContext(repo);
		await handleGitPush(ctx);
		assert.equal(notifications.at(-1)?.level, "error");
		assert.match(notifications.at(-1)?.message ?? "", /Run \/git pull first/);
	});
});

describe("/git branch", { concurrency: true }, () => {
	it("checks out a remote-only branch with tracking", async () => {
		const { repo, cloneAnother } = await createFixture();
		const other = await cloneAnother();
		await git(other, "switch", "-q", "-c", "remote-only");
		await commit(other, "r.txt");
		await git(other, "push", "-q", "-u", "origin", "remote-only");
		await git(repo, "fetch", "-q");

		const listing = await listBranches(repo);
		assert.deepEqual(listing.remoteOnly, [{ name: "remote-only", remotes: ["origin"] }]);

		const { ctx, lastMessage } = fakeContext(repo);
		await handleGitBranch(ctx, "remote-only");
		assert.match(lastMessage(), /tracking 'origin\/remote-only'/);
		assert.equal(await git(repo, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/remote-only");
	});

	it("creates a new branch only after confirmation", async () => {
		const { repo } = await createFixture();
		await handleGitBranch(fakeContext(repo, [false]).ctx, "nope");
		assert.equal(await git(repo, "branch", "--show-current"), "main");

		await handleGitBranch(fakeContext(repo, [true]).ctx, "yes");
		assert.equal(await git(repo, "branch", "--show-current"), "yes");
	});
});

describe("/git cleanup", { concurrency: true }, () => {
	/**
	 * - merged: pushed, merged into main, then deleted on the remote;
	 * - squashed: pushed, squash-merged, deleted on the remote (looks unmerged to git);
	 * - fresh: just created from main;
	 * - wip: never pushed, with its own commit.
	 */
	async function cleanupFixture() {
		const fixture = await createFixture();
		const { repo } = fixture;

		await git(repo, "switch", "-q", "-c", "merged");
		await commit(repo, "merged.txt");
		await git(repo, "push", "-q", "-u", "origin", "merged");

		await git(repo, "switch", "-q", "-c", "squashed", "main");
		await commit(repo, "squashed.txt");
		await git(repo, "push", "-q", "-u", "origin", "squashed");

		await git(repo, "switch", "-q", "main");
		await git(repo, "merge", "-q", "--no-ff", "-m", "merge", "merged");
		await git(repo, "merge", "-q", "--squash", "squashed");
		await git(repo, "commit", "-q", "-m", "squash");
		await git(repo, "push", "-q", "origin", "main", ":merged", ":squashed");

		await git(repo, "branch", "fresh");
		await git(repo, "switch", "-q", "-c", "wip");
		await commit(repo, "wip.txt");
		await git(repo, "switch", "-q", "main");
		return fixture;
	}

	const localBranches = async (repo: string) =>
		(await git(repo, "for-each-ref", "refs/heads", "--format=%(refname:short)")).split("\n");

	it("deletes merged branches, force-deletes squashed ones on request, keeps the rest", async () => {
		const { repo } = await cleanupFixture();
		const { ctx, prompts, lastMessage } = fakeContext(repo, ["Delete all 2 branches", true]);
		await handleGitCleanup(ctx);

		assert.match(prompts[0] ?? "", /Delete all 2 branches/);
		assert.match(prompts[1] ?? "", /squashed/);
		assert.match(lastMessage(), /Deleted 2 branches/);
		assert.deepEqual((await localBranches(repo)).sort(), ["fresh", "main", "wip"]);
	});

	it("keeps squashed branches when force-delete is declined", async () => {
		const { repo } = await cleanupFixture();
		const { ctx, lastMessage } = fakeContext(repo, ["Delete all 2 branches", false]);
		await handleGitCleanup(ctx);
		assert.match(lastMessage(), /squashed: kept, not fully merged/);
		assert.deepEqual((await localBranches(repo)).sort(), ["fresh", "main", "squashed", "wip"]);
	});

	it("deletes nothing when cancelled", async () => {
		const { repo } = await cleanupFixture();
		const { ctx, lastMessage } = fakeContext(repo, ["Cancel"]);
		await handleGitCleanup(ctx);
		assert.equal(lastMessage(), "Operation cancelled.");
		assert.equal((await localBranches(repo)).length, 5);
	});

	it("never offers a branch checked out in another worktree", async () => {
		const { repo } = await createFixture();
		await git(repo, "switch", "-q", "-c", "elsewhere");
		await git(repo, "push", "-q", "-u", "origin", "elsewhere");
		await git(repo, "switch", "-q", "main");
		await git(repo, "push", "-q", "origin", ":elsewhere");
		const worktrees = tempDir();
		mkdirSync(worktrees, { recursive: true });
		await git(repo, "worktree", "add", "-q", join(worktrees, "wt"), "elsewhere");

		const { ctx, lastMessage } = fakeContext(repo);
		await handleGitCleanup(ctx);
		assert.equal(lastMessage(), "No branches to clean up.");
	});
});

describe("git failures are reported, never mistaken for missing data", { concurrency: true }, () => {
	it("getCurrentBranch: undefined on a detached HEAD, GitError when git fails", async () => {
		const { repo } = await createFixture();
		await git(repo, "switch", "-q", "--detach");
		assert.equal(await getCurrentBranch(repo), undefined);
		await assert.rejects(getCurrentBranch(tempDir()), GitError);
	});

	it("localBranchExists: false only when the branch is missing", async () => {
		const { repo } = await createFixture();
		assert.equal(await localBranchExists(repo, "main"), true);
		assert.equal(await localBranchExists(repo, "missing"), false);
		await assert.rejects(localBranchExists(tempDir(), "main"), GitError);
	});

	it("listBranches throws instead of returning an empty list", async () => {
		await assert.rejects(listBranches(tempDir()), GitError);
	});

	it("/git cleanup reports a failed query instead of offering fewer branches", async () => {
		const dir = tempDir();
		await git(dir, "init", "-q");
		await commit(dir, "a.txt");
		// origin/HEAD points to a ref that does not exist, so the queries on the base branch fail.
		await git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/missing");
		const { ctx, notifications, prompts } = fakeContext(dir);
		const { services, refreshes } = testServices();
		await runGitCommand(ctx, "cleanup", services);
		assert.deepEqual(prompts, []);
		assert.equal(notifications.at(-1)?.level, "error");
		// Both the --merged listing and resolving the base fail; they run in parallel, so either may be reported.
		assert.match(
			notifications.at(-1)?.message ?? "",
			/^\/git cleanup: (Listing merged branches|Resolving the default branch) failed: /,
		);
		assert.equal(refreshes(), 1);
	});
});

describe("/git dispatch", { concurrency: true }, () => {
	it("rejects directories that are not repositories", async () => {
		const { ctx, lastMessage } = fakeContext(tempDir());
		await runGitCommand(ctx, "status", testServices().services);
		assert.equal(lastMessage(), "The current directory is not a git repository.");
	});

	it("shows the usage, rejects unknown subcommands and unexpected arguments", async () => {
		const { repo } = await createFixture();
		const { ctx, notifications } = fakeContext(repo);
		const { services } = testServices();
		await runGitCommand(ctx, "  ", services);
		await runGitCommand(ctx, "nope", services);
		await runGitCommand(ctx, "pull origin", services);
		assert.deepEqual(
			notifications.map((x) => x.level),
			["info", "error", "error"],
		);
		assert.match(notifications[0]?.message ?? "", /^Usage: /);
		assert.match(notifications[1]?.message ?? "", /^Unknown command 'nope'/);
		assert.equal(notifications[2]?.message, "/git pull takes no arguments.");
	});

	it("runs the subcommand and then refreshes the footer counters", async () => {
		const { repo } = await createFixture();
		const { ctx, lastMessage } = fakeContext(repo);
		const { services, refreshes } = testServices();
		await runGitCommand(ctx, "status", services);
		assert.match(lastMessage(), /^On branch main/);
		assert.equal(refreshes(), 1);
	});
});

describe("git footer", { concurrency: true }, () => {
	const isFactory = (call: unknown) => typeof call === "function";
	const savedSettings = (path: string) => JSON.parse(readFileSync(path, "utf8"));

	it("is shown by default when a session starts in a repository in interactive mode", async () => {
		const { repo } = await createFixture();
		const { ctx, footerCalls } = fakeContext(repo);
		await testServices().services.footer.start(ctx);
		assert.equal(footerCalls.length, 1);
		assert.ok(isFactory(footerCalls[0]));
	});

	it("is not shown outside interactive mode or outside a repository", async () => {
		const { repo } = await createFixture();
		const print = fakeContext(repo, { mode: "print" });
		await testServices().services.footer.start(print.ctx);
		const elsewhere = fakeContext(tempDir());
		await testServices().services.footer.start(elsewhere.ctx);
		assert.deepEqual([...print.footerCalls, ...elsewhere.footerCalls], []);
	});

	it("/git footer off restores pi's footer now and in every later session", async () => {
		const { repo } = await createFixture();
		const { services, settingsPath } = testServices();
		const { ctx, footerCalls, lastMessage } = fakeContext(repo);
		await services.footer.start(ctx);
		await runGitCommand(ctx, "footer off", services);

		assert.equal(footerCalls.length, 2);
		assert.equal(footerCalls[1], undefined);
		assert.match(lastMessage(), /^Git footer: off\./);
		assert.deepEqual(savedSettings(settingsPath), { footer: false });

		// Another terminal: a new pi session with its own controller and the same settings file.
		const other = fakeContext(repo);
		await testServices(settingsPath).services.footer.start(other.ctx);
		assert.deepEqual(other.footerCalls, []);
	});

	it("/git footer on shows it right away", async () => {
		const { repo } = await createFixture();
		const settingsPath = join(tempDir(), "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ footer: false, other: 1 }));
		const { services } = testServices(settingsPath);
		const { ctx, footerCalls, lastMessage } = fakeContext(repo);
		await services.footer.start(ctx);
		assert.deepEqual(footerCalls, []);

		await runGitCommand(ctx, "footer ON", services);
		assert.equal(footerCalls.length, 1);
		assert.ok(isFactory(footerCalls[0]));
		assert.equal(lastMessage().split("\n")[0], "Git footer: on.");
		// Keys the extension does not know are kept.
		assert.deepEqual(savedSettings(settingsPath), { footer: true, other: 1 });
	});

	it("works outside a repository, where it only saves the preference", async () => {
		const { services, settingsPath } = testServices();
		const { ctx, footerCalls, lastMessage } = fakeContext(tempDir());
		await runGitCommand(ctx, "footer", services);
		assert.match(lastMessage(), /^Git footer: on\. It is shown in interactive mode inside a git repository/);
		assert.ok(lastMessage().includes(settingsPath));

		await runGitCommand(ctx, "footer off", services);
		assert.deepEqual(footerCalls, []);
		assert.deepEqual(savedSettings(settingsPath), { footer: false });
	});

	it("rejects unknown options and never overwrites an invalid settings file", async () => {
		const { repo } = await createFixture();
		const settingsPath = join(tempDir(), "settings.json");
		writeFileSync(settingsPath, "{ not json");
		const { services } = testServices(settingsPath);
		const { ctx, notifications } = fakeContext(repo);

		await runGitCommand(ctx, "footer maybe", services);
		await runGitCommand(ctx, "footer off", services);
		assert.deepEqual(
			notifications.map((x) => x.level),
			["error", "error"],
		);
		assert.match(notifications[0]?.message ?? "", /^Unknown footer option 'maybe'/);
		assert.match(notifications[1]?.message ?? "", /is not valid JSON/);
		assert.equal(readFileSync(settingsPath, "utf8"), "{ not json");
	});
});
