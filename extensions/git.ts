import { spawn } from "node:child_process";

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
	/** True when the process was terminated: timeout or output limit. */
	killed: boolean;
};

export type AheadBehind = {
	incoming: number;
	outgoing: number;
	available: boolean;
};

export const GIT_TIMEOUT_MS = 20_000;
export const GIT_NETWORK_TIMEOUT_MS = 120_000;

/** Exit code reported when the git executable cannot be started. */
export const GIT_NOT_FOUND_CODE = 127;

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;

/**
 * Environment for every git invocation.
 *
 * - git runs without a terminal, so it must never prompt: a credential prompt would block
 *   until the timeout (or, on POSIX, read from pi's own terminal). Missing credentials make
 *   git fail right away instead.
 * - The extension parses some of git's messages ("not fully merged", "[rejected]", …), so
 *   they must not be translated.
 */
export function gitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return {
		...base,
		GIT_TERMINAL_PROMPT: "0",
		GCM_INTERACTIVE: "never",
		LC_ALL: "C",
		LANGUAGE: "",
	};
}

/**
 * Run git without a shell. Never rejects: spawn failures are reported with
 * {@link GIT_NOT_FOUND_CODE}, timeouts with `killed: true`.
 *
 * On POSIX git runs in its own session, so it has no controlling terminal and helpers such as
 * ssh cannot prompt on pi's terminal; on timeout the whole process group is terminated.
 */
export function runGit(cwd: string, args: string[], timeout: number = GIT_TIMEOUT_MS): Promise<GitExecResult> {
	return new Promise((resolvePromise) => {
		const isPosix = process.platform !== "win32";
		let settled = false;
		let killed = false;
		let outputBytes = 0;
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];

		const finish = (result: GitExecResult) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			clearTimeout(forceKillTimer);
			resolvePromise(result);
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("git", args, {
				cwd,
				env: gitEnvironment(),
				stdio: ["ignore", "pipe", "pipe"],
				detached: isPosix,
				windowsHide: true,
			});
		} catch (error) {
			resolvePromise({ code: GIT_NOT_FOUND_CODE, stdout: "", stderr: String(error), killed: false });
			return;
		}

		let forceKillTimer: NodeJS.Timeout | undefined;
		const terminate = () => {
			killed = true;
			if (!isPosix) {
				// child.kill() would only end git.exe and leave its children (sh, ssh, …) running.
				if (child.pid !== undefined) {
					spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on(
						"error",
						() => child.kill(),
					);
				} else {
					child.kill();
				}
				return;
			}
			const signalGroup = (signal: NodeJS.Signals) => {
				try {
					if (child.pid !== undefined) {
						process.kill(-child.pid, signal);
					} else {
						child.kill(signal);
					}
				} catch {
					// Already gone.
				}
			};
			signalGroup("SIGTERM");
			forceKillTimer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
		};

		const timer = setTimeout(terminate, timeout);

		const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
			outputBytes += chunk.length;
			if (outputBytes > MAX_OUTPUT_BYTES) {
				if (!killed) {
					terminate();
				}
				return;
			}
			chunks.push(chunk);
		};
		child.stdout?.on("data", collect(stdout));
		child.stderr?.on("data", collect(stderr));

		child.on("error", (error: NodeJS.ErrnoException) => {
			const notFound = error.code === "ENOENT";
			finish({
				code: GIT_NOT_FOUND_CODE,
				stdout: "",
				stderr: notFound ? "git executable not found. Install git and make sure it is on your PATH." : error.message,
				killed: false,
			});
		});

		child.on("close", (code) => {
			finish({
				// A terminated command is a failure even if it managed to exit cleanly: its output may
				// be truncated, and callers check the exit code first.
				code: killed ? code || 1 : (code ?? 1),
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				killed,
			});
		});
	});
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

/**
 * A git query failed; the message is ready to show to the user.
 *
 * Queries distinguish "git says there is none" from "git failed": a timeout or a locked
 * repository must never be reported as a missing branch or upstream, because commands act
 * on that answer (offering to set an upstream, to create a branch, …).
 */
export class GitError extends Error {
	constructor(action: string, result: GitExecResult, timeout: number = GIT_TIMEOUT_MS) {
		super(`${action} failed: ${describeFailure(result, timeout)}`);
		this.name = "GitError";
	}
}

/** Run a git query that must succeed; throws {@link GitError} otherwise. */
export async function queryGit(
	cwd: string,
	args: string[],
	action: string,
	timeout: number = GIT_TIMEOUT_MS,
): Promise<GitExecResult> {
	const result = await runGit(cwd, args, timeout);
	if (result.code !== 0) {
		throw new GitError(action, result, timeout);
	}
	return result;
}

export type RepositoryState = "repository" | "not-repository" | "git-missing";

export async function getRepositoryState(cwd: string): Promise<RepositoryState> {
	const result = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (result.code === GIT_NOT_FOUND_CODE) {
		return "git-missing";
	}
	if (result.killed) {
		throw new GitError("Checking the repository", result);
	}
	return result.code === 0 && result.stdout.trim() === "true" ? "repository" : "not-repository";
}

/** For background features (autocomplete): any failure counts as "not a repository". */
export async function isGitRepository(cwd: string): Promise<boolean> {
	try {
		return (await getRepositoryState(cwd)) === "repository";
	} catch {
		return false;
	}
}

/** Current branch name, or undefined on a detached HEAD. Throws {@link GitError} when git fails. */
export async function getCurrentBranch(cwd: string): Promise<string | undefined> {
	const result = await queryGit(cwd, ["branch", "--show-current"], "Reading the current branch");
	return result.stdout.trim() || undefined;
}

/**
 * Whether a full ref name exists. Throws {@link GitError} when git fails: `show-ref --verify`
 * exits with 1 only for a missing ref.
 */
export async function refExists(cwd: string, ref: string): Promise<boolean> {
	const result = await runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
	if (result.code === 0) {
		return true;
	}
	if (result.code === 1 && !result.killed) {
		return false;
	}
	throw new GitError(`Looking up ${ref}`, result);
}

/**
 * Upstream of a local branch ("origin/main"), or undefined when none is configured. Throws
 * {@link GitError} when git fails, so a failed query is never mistaken for a missing upstream.
 */
export async function getUpstream(cwd: string, branch: string): Promise<string | undefined> {
	const result = await queryGit(
		cwd,
		["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`],
		"Reading the upstream branch",
	);
	return result.stdout.trim() || undefined;
}

function parseCount(text: string | undefined): number {
	const value = Number(text ?? "0");
	return Number.isFinite(value) ? value : 0;
}

/** Parse the output of `git rev-list --left-right --count base...HEAD`. */
export function parseLeftRightCount(stdout: string): AheadBehind {
	const parts = stdout.trim().split(/\s+/);
	return { incoming: parseCount(parts[0]), outgoing: parseCount(parts[1]), available: true };
}

/** Undefined when `base` does not resolve (e.g. no upstream); throws when git fails otherwise. */
async function countLeftRight(cwd: string, base: string): Promise<AheadBehind | undefined> {
	const result = await runGit(cwd, ["rev-list", "--left-right", "--count", `${base}...HEAD`]);
	if (result.killed) {
		throw new GitError("Counting commits", result);
	}
	return result.code === 0 ? parseLeftRightCount(result.stdout) : undefined;
}

/**
 * Prefer the configured upstream. Without one, compare against a same-named branch on a
 * remote; if there is none, the branch was never pushed, so every commit that is not on
 * any remote is outgoing and nothing can be incoming.
 *
 * The counters are informational, so when git fails they are reported as unavailable
 * (hidden) rather than as an error, and never as wrong numbers.
 */
export async function getAheadBehind(cwd: string): Promise<AheadBehind> {
	try {
		return await computeAheadBehind(cwd);
	} catch {
		return { incoming: 0, outgoing: 0, available: false };
	}
}

async function computeAheadBehind(cwd: string): Promise<AheadBehind> {
	const unavailable: AheadBehind = { incoming: 0, outgoing: 0, available: false };

	const fromUpstream = await countLeftRight(cwd, "@{upstream}");
	if (fromUpstream) {
		return fromUpstream;
	}

	const branch = await getCurrentBranch(cwd);
	if (!branch) {
		return unavailable;
	}

	const { remotes, byBranch } = await listRemoteBranches(cwd);
	if (remotes.length === 0) {
		return unavailable;
	}

	const owners = byBranch.get(branch) ?? [];
	if (owners.length > 0) {
		const remote = owners.includes("origin") ? "origin" : owners[0];
		return (await countLeftRight(cwd, `refs/remotes/${remote}/${branch}`)) ?? unavailable;
	}

	const unpushed = await queryGit(cwd, ["rev-list", "--count", "HEAD", "--not", "--remotes"], "Counting commits");
	return { incoming: 0, outgoing: parseCount(unpushed.stdout.trim()), available: true };
}

/**
 * Split "origin/feature/x" into remote and branch, matching the longest known remote name
 * so that remotes containing slashes are handled correctly.
 */
export function splitRemoteRef(ref: string, remotes: string[]): { remote: string; branch: string } | undefined {
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

/** Group remote-tracking refs ("origin/x") by branch name. */
export function groupRemoteRefs(refs: string[], remotes: string[]): Map<string, string[]> {
	const byBranch = new Map<string, string[]>();
	for (const ref of refs) {
		const parsed = splitRemoteRef(ref, remotes);
		if (!parsed) {
			continue;
		}
		const owners = byBranch.get(parsed.branch) ?? [];
		owners.push(parsed.remote);
		byBranch.set(parsed.branch, owners);
	}
	return byBranch;
}

/** Map each branch name found under refs/remotes to the remotes that have it. */
export async function listRemoteBranches(cwd: string): Promise<{ remotes: string[]; byBranch: Map<string, string[]> }> {
	const [remoteRefsResult, remotesResult] = await Promise.all([
		queryGit(cwd, ["for-each-ref", "refs/remotes", "--format=%(refname:lstrip=2)"], "Listing remote branches"),
		queryGit(cwd, ["remote"], "Listing remotes"),
	]);

	const remotes = splitLines(remotesResult.stdout);
	const refs = splitLines(remoteRefsResult.stdout);
	return { remotes, byBranch: groupRemoteRefs(refs, remotes) };
}

export async function listBranches(cwd: string): Promise<BranchListing> {
	const [localResult, { byBranch: remoteBranches }, currentBranch] = await Promise.all([
		queryGit(cwd, ["for-each-ref", "refs/heads", "--format=%(refname:short)"], "Listing branches"),
		listRemoteBranches(cwd),
		getCurrentBranch(cwd),
	]);

	const locals = splitLines(localResult.stdout);
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

export async function localBranchExists(cwd: string, branchName: string): Promise<boolean> {
	return refExists(cwd, `refs/heads/${branchName}`);
}

export async function findRemotesWithBranch(cwd: string, branchName: string): Promise<string[]> {
	const { byBranch } = await listRemoteBranches(cwd);
	return byBranch.get(branchName) ?? [];
}

/**
 * Validate a user-supplied branch name. Returns the normalized name (git expands
 * shorthands such as `@{-1}`) or an error message.
 */
export async function validateBranchName(cwd: string, input: string): Promise<{ name: string } | { error: string }> {
	if (/\s/.test(input)) {
		return { error: `Invalid branch name '${input}': branch names cannot contain whitespace.` };
	}
	if (input.startsWith("-")) {
		return { error: `Invalid branch name '${input}': branch names cannot start with '-'.` };
	}
	const result = await runGit(cwd, ["check-ref-format", "--branch", input]);
	if (result.killed || result.code === GIT_NOT_FOUND_CODE) {
		throw new GitError("Validating the branch name", result);
	}
	if (result.code !== 0) {
		return { error: `Invalid branch name '${input}'.` };
	}
	return { name: result.stdout.trim() || input };
}
