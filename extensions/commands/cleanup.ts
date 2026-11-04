import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	describeFailure,
	GIT_NETWORK_TIMEOUT_MS,
	GitError,
	getCurrentBranch,
	localBranchExists,
	queryGit,
	refExists,
	runGit,
	splitLines,
} from "../git.ts";
import { notifyCancelled, plural } from "./shared.ts";

/** Long-lived branches that are never offered for deletion, even when fully merged. */
export const PROTECTED_BRANCHES: ReadonlySet<string> = new Set(["main", "master", "develop", "dev"]);

export type Candidate = {
	name: string;
	reasons: string[];
};

type DeleteOutcome = {
	deleted: string[];
	notMerged: string[];
	failed: string[];
};

/** A local branch as reported by `git for-each-ref` with {@link LOCAL_BRANCH_FORMAT}. */
export type LocalBranch = {
	name: string;
	/** Commit the branch points to. */
	oid: string;
	/** Configured upstream ("origin/x"), empty when none. It is still set when the upstream is gone. */
	upstream: string;
	/** `%(upstream:track)`, e.g. "[gone]", "[ahead 1]" or empty. */
	track: string;
	/** Path of the worktree that has the branch checked out, empty when none. */
	worktree: string;
};

const LOCAL_BRANCH_FORMAT =
	"%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(worktreepath)";

export function parseLocalBranches(stdout: string): LocalBranch[] {
	return splitLines(stdout).map((line) => {
		const [name = "", oid = "", upstream = "", track = "", worktree = ""] = line.split("\0");
		return { name, oid, upstream, track, worktree };
	});
}

export type CleanupInput = {
	branches: LocalBranch[];
	/** Names of local branches whose tip is reachable from the base branch. */
	merged: ReadonlySet<string>;
	/** Base branch, e.g. "origin/main" or "main". */
	base?: string;
	/** Commit the base branch points to. */
	baseOid?: string;
	current?: string;
	protectedNames?: ReadonlySet<string>;
};

/**
 * Decide which local branches can be offered for deletion.
 *
 * - Upstream deleted on the remote ("[gone]"): offered.
 * - Merged into the base: offered only if the branch was published (has an upstream) and does
 *   not point exactly at the base. A branch just created from the base, or never pushed, is
 *   "merged" for git as well, but is far more likely to be work about to start than work done.
 * - Never offered: protected names, the current branch, the base, and branches checked out in
 *   any worktree (git refuses to delete those anyway).
 */
export function selectCleanupCandidates(input: CleanupInput): Candidate[] {
	const protectedNames = new Set(input.protectedNames ?? PROTECTED_BRANCHES);
	if (input.current) {
		protectedNames.add(input.current);
	}
	if (input.base) {
		protectedNames.add(input.base);
		protectedNames.add(input.base.replace(/^[^/]+\//, ""));
	}

	const candidates: Candidate[] = [];
	for (const branch of input.branches) {
		if (!branch.name || protectedNames.has(branch.name) || branch.worktree) {
			continue;
		}
		const reasons: string[] = [];
		if (branch.track === "[gone]") {
			reasons.push("upstream deleted");
		}
		const isFreshOrPrivate = !branch.upstream || (input.baseOid !== undefined && branch.oid === input.baseOid);
		if (input.base && input.merged.has(branch.name) && !isFreshOrPrivate) {
			reasons.push(`merged into ${input.base}`);
		}
		if (reasons.length > 0) {
			candidates.push({ name: branch.name, reasons });
		}
	}
	return candidates.sort((a, b) => a.name.localeCompare(b.name));
}

/** The branch other branches get merged into: origin's HEAD, else a local or remote main/master. */
async function findBaseBranch(cwd: string): Promise<string | undefined> {
	const originHead = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	// Exit code 1 only means origin/HEAD is not set; anything else is a failure.
	if (originHead.killed || originHead.code > 1) {
		throw new GitError("Finding the default branch", originHead);
	}
	if (originHead.code === 0 && originHead.stdout.trim()) {
		return originHead.stdout.trim();
	}
	for (const name of ["main", "master"]) {
		if (await localBranchExists(cwd, name)) {
			return name;
		}
	}
	for (const ref of ["origin/main", "origin/master"]) {
		if (await refExists(cwd, `refs/remotes/${ref}`)) {
			return ref;
		}
	}
	return undefined;
}

export async function findCleanupCandidates(cwd: string): Promise<Candidate[]> {
	const base = await findBaseBranch(cwd);
	// A failed query must not shrink the protections (e.g. an unknown current branch), so every
	// query has to succeed.
	const [branchesResult, mergedResult, baseOidResult, current] = await Promise.all([
		queryGit(cwd, ["for-each-ref", "refs/heads", `--format=${LOCAL_BRANCH_FORMAT}`], "Listing branches"),
		base
			? queryGit(
					cwd,
					["for-each-ref", "refs/heads", "--merged", base, "--format=%(refname:short)"],
					"Listing merged branches",
				)
			: undefined,
		base ? queryGit(cwd, ["rev-parse", "--verify", `${base}^{commit}`], "Resolving the default branch") : undefined,
		getCurrentBranch(cwd),
	]);

	return selectCleanupCandidates({
		branches: parseLocalBranches(branchesResult.stdout),
		merged: new Set(mergedResult ? splitLines(mergedResult.stdout) : []),
		base,
		baseOid: baseOidResult?.stdout.trim(),
		current,
	});
}

function describeCandidate(candidate: Candidate): string {
	return `${candidate.name} (${candidate.reasons.join(", ")})`;
}

/** Ask which candidates to delete. Returns undefined when the user cancels. */
async function chooseBranches(ctx: ExtensionCommandContext, candidates: Candidate[]): Promise<Candidate[] | undefined> {
	if (candidates.length === 1) {
		const confirm = await ctx.ui.confirm(
			"Clean up branches",
			`Delete local branch ${describeCandidate(candidates[0])}?`,
		);
		return confirm ? candidates : undefined;
	}

	ctx.ui.notify(
		["Local branches that can be deleted:", ...candidates.map((c) => `  ${describeCandidate(c)}`)].join("\n"),
		"info",
	);
	const deleteAll = `Delete all ${candidates.length} branches`;
	const oneByOne = "Choose one by one";
	const choice = await ctx.ui.select("Clean up branches", [deleteAll, oneByOne, "Cancel"]);
	if (choice === deleteAll) {
		return candidates;
	}
	if (choice !== oneByOne) {
		return undefined;
	}

	const selected: Candidate[] = [];
	for (const candidate of candidates) {
		if (await ctx.ui.confirm("Clean up branches", `Delete local branch ${describeCandidate(candidate)}?`)) {
			selected.push(candidate);
		}
	}
	return selected;
}

/** Delete branches; `git branch` reports "Deleted branch x (was abc1234)." on stdout. */
async function deleteBranches(cwd: string, names: string[], force: boolean, outcome: DeleteOutcome): Promise<void> {
	for (const name of names) {
		const result = await runGit(cwd, ["branch", force ? "-D" : "-d", name]);
		if (result.code === 0) {
			const was = result.stdout.match(/\(was ([0-9a-f]+)\)/)?.[1];
			outcome.deleted.push(was ? `${name} (was ${was})` : name);
		} else if (!force && /not fully merged/.test(result.stderr)) {
			outcome.notMerged.push(name);
		} else {
			outcome.failed.push(`${name}: ${describeFailure(result)}`);
		}
	}
}

export async function handleGitCleanup(ctx: ExtensionCommandContext): Promise<void> {
	// Prune first so branches whose upstream was deleted on the remote are detected as gone.
	const fetchResult = await runGit(ctx.cwd, ["fetch", "--all", "--prune"], GIT_NETWORK_TIMEOUT_MS);
	if (fetchResult.code !== 0) {
		ctx.ui.notify(
			`git fetch failed, using local data only: ${describeFailure(fetchResult, GIT_NETWORK_TIMEOUT_MS)}`,
			"warning",
		);
	}

	const candidates = await findCleanupCandidates(ctx.cwd);
	if (candidates.length === 0) {
		ctx.ui.notify("No branches to clean up.", "info");
		return;
	}

	const selected = await chooseBranches(ctx, candidates);
	if (!selected) {
		notifyCancelled(ctx);
		return;
	}
	if (selected.length === 0) {
		ctx.ui.notify("No branches deleted.", "info");
		return;
	}

	const outcome: DeleteOutcome = { deleted: [], notMerged: [], failed: [] };
	await deleteBranches(
		ctx.cwd,
		selected.map((c) => c.name),
		false,
		outcome,
	);

	// Branches merged with squash or rebase look unmerged to git; deleting them needs -D. A deleted
	// upstream does not prove the work was merged, so say plainly what force-deleting means.
	if (outcome.notMerged.length > 0) {
		const force = await ctx.ui.confirm(
			"Branches not fully merged",
			`${plural(outcome.notMerged.length, "branch has", "branches have")} commits that git cannot find ` +
				`in the base branch: ${outcome.notMerged.join(", ")}. This is normal after squash or rebase merges, ` +
				"but it can also mean the work was never merged. Force delete them? " +
				"The summary will show the commit to restore each one from.",
		);
		const notMerged = outcome.notMerged;
		outcome.notMerged = [];
		if (force) {
			await deleteBranches(ctx.cwd, notMerged, true, outcome);
		} else {
			outcome.failed.push(...notMerged.map((name) => `${name}: kept, not fully merged`));
		}
	}

	const lines: string[] = [];
	if (outcome.deleted.length > 0) {
		lines.push(
			`Deleted ${plural(outcome.deleted.length, "branch", "branches")}:`,
			...outcome.deleted.map((x) => `  ${x}`),
		);
	}
	if (outcome.failed.length > 0) {
		lines.push("Not deleted:", ...outcome.failed.map((x) => `  ${x}`));
	}
	ctx.ui.notify(lines.join("\n"), outcome.failed.length > 0 ? "warning" : "info");
}
