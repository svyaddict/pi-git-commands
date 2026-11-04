import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	describeFailure,
	GIT_NETWORK_TIMEOUT_MS,
	getCurrentBranch,
	localBranchExists,
	runGit,
	splitLines,
} from "../git.ts";
import { notifyCancelled, plural } from "./shared.ts";

/** Long-lived branches that are never offered for deletion, even when fully merged. */
const PROTECTED_BRANCHES = new Set(["main", "master", "develop", "dev"]);

type Candidate = {
	name: string;
	reasons: string[];
};

type DeleteOutcome = {
	deleted: string[];
	notMerged: string[];
	failed: string[];
};

/** The branch other branches get merged into: origin's HEAD, else a local or remote main/master. */
async function findBaseBranch(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const originHead = await runGit(pi, cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (originHead.code === 0 && originHead.stdout.trim()) {
		return originHead.stdout.trim();
	}
	for (const name of ["main", "master"]) {
		if (await localBranchExists(pi, cwd, name)) {
			return name;
		}
	}
	for (const ref of ["origin/main", "origin/master"]) {
		const result = await runGit(pi, cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/${ref}`]);
		if (result.code === 0) {
			return ref;
		}
	}
	return undefined;
}

async function findCandidates(pi: ExtensionAPI, cwd: string): Promise<Candidate[]> {
	const base = await findBaseBranch(pi, cwd);
	const [trackResult, mergedResult, current] = await Promise.all([
		runGit(pi, cwd, ["for-each-ref", "refs/heads", "--format=%(refname:short)%09%(upstream:track)"]),
		base ? runGit(pi, cwd, ["for-each-ref", "refs/heads", "--merged", base, "--format=%(refname:short)"]) : undefined,
		getCurrentBranch(pi, cwd),
	]);

	const protectedNames = new Set(PROTECTED_BRANCHES);
	if (current) {
		protectedNames.add(current);
	}
	if (base) {
		protectedNames.add(base.replace(/^[^/]+\//, ""));
		protectedNames.add(base);
	}

	const candidates = new Map<string, Candidate>();
	const addReason = (name: string, reason: string) => {
		if (protectedNames.has(name)) {
			return;
		}
		const candidate = candidates.get(name) ?? { name, reasons: [] };
		candidate.reasons.push(reason);
		candidates.set(name, candidate);
	};

	if (trackResult.code === 0) {
		for (const line of splitLines(trackResult.stdout)) {
			const [name, track] = line.split("\t");
			if (name && track === "[gone]") {
				addReason(name, "upstream deleted");
			}
		}
	}
	if (base && mergedResult?.code === 0) {
		for (const name of splitLines(mergedResult.stdout)) {
			addReason(name, `merged into ${base}`);
		}
	}

	return Array.from(candidates.values()).sort((a, b) => a.name.localeCompare(b.name));
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
async function deleteBranches(
	pi: ExtensionAPI,
	cwd: string,
	names: string[],
	force: boolean,
	outcome: DeleteOutcome,
): Promise<void> {
	for (const name of names) {
		const result = await runGit(pi, cwd, ["branch", force ? "-D" : "-d", name]);
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

export async function handleGitCleanup(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	// Prune first so branches whose upstream was deleted on the remote are detected as gone.
	const fetchResult = await runGit(pi, ctx.cwd, ["fetch", "--all", "--prune"], GIT_NETWORK_TIMEOUT_MS);
	if (fetchResult.code !== 0) {
		ctx.ui.notify(
			`git fetch failed, using local data only: ${describeFailure(fetchResult, GIT_NETWORK_TIMEOUT_MS)}`,
			"warning",
		);
	}

	const candidates = await findCandidates(pi, ctx.cwd);
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
		pi,
		ctx.cwd,
		selected.map((c) => c.name),
		false,
		outcome,
	);

	// Branches merged with squash or rebase look unmerged to git; deleting them needs -D.
	if (outcome.notMerged.length > 0) {
		const force = await ctx.ui.confirm(
			"Branches not fully merged",
			`${plural(outcome.notMerged.length, "branch has", "branches have")} commits that are not merged ` +
				`(common after squash or rebase merges): ${outcome.notMerged.join(", ")}. Force delete them?`,
		);
		const notMerged = outcome.notMerged;
		outcome.notMerged = [];
		if (force) {
			await deleteBranches(pi, ctx.cwd, notMerged, true, outcome);
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
