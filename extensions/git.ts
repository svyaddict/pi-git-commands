import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type BranchInfo = {
	name: string;
	isCurrent: boolean;
	isLocalOnly: boolean;
};

export type RemoteBranchInfo = {
	name: string;
	remotes: string[];
};

export type BranchListing = {
	locals: BranchInfo[];
	/** Branches that exist on a remote but have no local counterpart. */
	remoteOnly: RemoteBranchInfo[];
};

export type GitExecResult = {
	code: number;
	stdout: string;
	stderr: string;
	killed: boolean;
};

export type AheadBehind = {
	incoming: number;
	outgoing: number;
	available: boolean;
};

export const GIT_TIMEOUT_MS = 20_000;
export const GIT_NETWORK_TIMEOUT_MS = 120_000;

export async function runGit(
	pi: ExtensionAPI,
	cwd: string,
	args: string[],
	timeout: number = GIT_TIMEOUT_MS,
): Promise<GitExecResult> {
	return pi.exec("git", args, { cwd, timeout });
}

export function describeFailure(result: GitExecResult, timeout: number = GIT_TIMEOUT_MS): string {
	if (result.killed) {
		return `timed out after ${Math.round(timeout / 1000)}s`;
	}
	return result.stderr.trim() || `exit code ${result.code}`;
}

export function splitLines(text: string): string[] {
	return text
		.split("\n")
		.map((x) => x.trim())
		.filter((x) => x.length > 0);
}

export async function isGitRepository(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const result = await runGit(pi, cwd, ["rev-parse", "--is-inside-work-tree"]);
	return result.code === 0;
}

export async function getCurrentBranch(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const result = await runGit(pi, cwd, ["branch", "--show-current"]);
	if (result.code !== 0) {
		return undefined;
	}
	const name = result.stdout.trim();
	return name || undefined;
}

export async function getUpstream(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const result = await runGit(pi, cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
	return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

function parseCount(text: string | undefined): number {
	const value = Number(text ?? "0");
	return Number.isFinite(value) ? value : 0;
}

async function countLeftRight(pi: ExtensionAPI, cwd: string, base: string): Promise<AheadBehind | undefined> {
	const result = await runGit(pi, cwd, ["rev-list", "--left-right", "--count", `${base}...HEAD`]);
	if (result.code !== 0) {
		return undefined;
	}
	const parts = result.stdout.trim().split(/\s+/);
	return { incoming: parseCount(parts[0]), outgoing: parseCount(parts[1]), available: true };
}

/**
 * Prefer the configured upstream. Without one, compare against a same-named branch on a
 * remote; if there is none, the branch was never pushed, so every commit that is not on
 * any remote is outgoing and nothing can be incoming.
 */
export async function getAheadBehind(pi: ExtensionAPI, cwd: string): Promise<AheadBehind> {
	const unavailable: AheadBehind = { incoming: 0, outgoing: 0, available: false };

	const fromUpstream = await countLeftRight(pi, cwd, "@{upstream}");
	if (fromUpstream) {
		return fromUpstream;
	}

	const branch = await getCurrentBranch(pi, cwd);
	if (!branch) {
		return unavailable;
	}

	const { remotes, byBranch } = await listRemoteBranches(pi, cwd);
	if (remotes.length === 0) {
		return unavailable;
	}

	const owners = byBranch.get(branch) ?? [];
	if (owners.length > 0) {
		const remote = owners.includes("origin") ? "origin" : owners[0];
		return (await countLeftRight(pi, cwd, `refs/remotes/${remote}/${branch}`)) ?? unavailable;
	}

	const unpushed = await runGit(pi, cwd, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
	if (unpushed.code !== 0) {
		return unavailable;
	}
	return { incoming: 0, outgoing: parseCount(unpushed.stdout.trim()), available: true };
}

/**
 * Split "origin/feature/x" into remote and branch, matching the longest known remote name
 * so that remotes containing slashes are handled correctly.
 */
function splitRemoteRef(ref: string, remotes: string[]): { remote: string; branch: string } | undefined {
	let best: string | undefined;
	for (const remote of remotes) {
		if (ref.startsWith(`${remote}/`) && (!best || remote.length > best.length)) {
			best = remote;
		}
	}
	if (!best) {
		return undefined;
	}
	const branch = ref.slice(best.length + 1);
	if (!branch || branch === "HEAD") {
		return undefined;
	}
	return { remote: best, branch };
}

/** Map each branch name found under refs/remotes to the remotes that have it. */
export async function listRemoteBranches(
	pi: ExtensionAPI,
	cwd: string,
): Promise<{ remotes: string[]; byBranch: Map<string, string[]> }> {
	const [remoteRefsResult, remotesResult] = await Promise.all([
		runGit(pi, cwd, ["for-each-ref", "refs/remotes", "--format=%(refname:lstrip=2)"]),
		runGit(pi, cwd, ["remote"]),
	]);

	const remotes = remotesResult.code === 0 ? splitLines(remotesResult.stdout) : [];
	const byBranch = new Map<string, string[]>();
	if (remoteRefsResult.code === 0) {
		for (const ref of splitLines(remoteRefsResult.stdout)) {
			const parsed = splitRemoteRef(ref, remotes);
			if (!parsed) {
				continue;
			}
			const owners = byBranch.get(parsed.branch) ?? [];
			owners.push(parsed.remote);
			byBranch.set(parsed.branch, owners);
		}
	}
	return { remotes, byBranch };
}

export async function listBranches(pi: ExtensionAPI, cwd: string): Promise<BranchListing> {
	const [localResult, { byBranch: remoteBranches }, currentResult] = await Promise.all([
		runGit(pi, cwd, ["for-each-ref", "refs/heads", "--format=%(refname:short)"]),
		listRemoteBranches(pi, cwd),
		runGit(pi, cwd, ["branch", "--show-current"]),
	]);

	if (localResult.code !== 0) {
		return { locals: [], remoteOnly: [] };
	}

	const locals = splitLines(localResult.stdout);

	const currentBranch = currentResult.code === 0 ? currentResult.stdout.trim() : "";
	const localSet = new Set(locals);

	return {
		locals: locals.map((name) => ({
			name,
			isCurrent: name === currentBranch,
			isLocalOnly: !remoteBranches.has(name),
		})),
		remoteOnly: Array.from(remoteBranches.entries())
			.filter(([name]) => !localSet.has(name))
			.map(([name, owners]) => ({ name, remotes: owners }))
			.sort((a, b) => a.name.localeCompare(b.name)),
	};
}

export async function localBranchExists(pi: ExtensionAPI, cwd: string, branchName: string): Promise<boolean> {
	const result = await runGit(pi, cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
	return result.code === 0;
}

export async function findRemotesWithBranch(pi: ExtensionAPI, cwd: string, branchName: string): Promise<string[]> {
	const { byBranch } = await listRemoteBranches(pi, cwd);
	return byBranch.get(branchName) ?? [];
}

/**
 * Validate a user-supplied branch name. Returns the normalized name (git expands
 * shorthands such as `@{-1}`) or an error message.
 */
export async function validateBranchName(
	pi: ExtensionAPI,
	cwd: string,
	input: string,
): Promise<{ name: string } | { error: string }> {
	if (/\s/.test(input)) {
		return { error: `Invalid branch name '${input}': branch names cannot contain whitespace.` };
	}
	if (input.startsWith("-")) {
		return { error: `Invalid branch name '${input}': branch names cannot start with '-'.` };
	}
	const result = await runGit(pi, cwd, ["check-ref-format", "--branch", input]);
	if (result.code !== 0) {
		return { error: `Invalid branch name '${input}'.` };
	}
	return { name: result.stdout.trim() || input };
}
