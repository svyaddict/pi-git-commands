import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	describeFailure,
	findRemotesWithBranch,
	GIT_NETWORK_TIMEOUT_MS,
	getCurrentBranch,
	getUpstream,
	runGit,
	splitLines,
} from "../git.ts";
import { notifyCancelled, pickRemote } from "./shared.ts";

function summarizePullOutput(stdout: string): string {
	const lines = splitLines(stdout);
	if (lines.length === 0) {
		return "Update completed.";
	}
	if (lines.length <= 3) {
		return lines.join(" ");
	}
	return `${lines[0]} … ${lines[lines.length - 1]}`;
}

/**
 * Make sure the current branch has an upstream before pulling. If it has none but a
 * same-named branch exists on a remote, offer to track it. Returns false when the pull
 * should not run.
 */
async function ensureUpstream(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<boolean> {
	if (await getUpstream(pi, ctx.cwd)) {
		return true;
	}

	const branch = await getCurrentBranch(pi, ctx.cwd);
	if (!branch) {
		ctx.ui.notify("git pull is not possible on a detached HEAD. Switch to a branch first.", "warning");
		return false;
	}

	// Refresh remote-tracking branches so a branch pushed from elsewhere is found.
	const fetchResult = await runGit(pi, ctx.cwd, ["fetch", "--prune"], GIT_NETWORK_TIMEOUT_MS);
	if (fetchResult.code !== 0) {
		ctx.ui.notify(`git fetch failed: ${describeFailure(fetchResult, GIT_NETWORK_TIMEOUT_MS)}`, "error");
		return false;
	}

	const remotes = await findRemotesWithBranch(pi, ctx.cwd, branch);
	if (remotes.length === 0) {
		ctx.ui.notify(
			`Branch '${branch}' has no upstream and does not exist on any remote, so there is nothing to pull. ` +
				"Push it first with /git push",
			"warning",
		);
		return false;
	}

	const remote = await pickRemote(ctx, `Branch '${branch}' exists on several remotes. Track which one?`, remotes);
	if (!remote) {
		notifyCancelled(ctx);
		return false;
	}

	const upstream = `${remote}/${branch}`;
	const confirm = await ctx.ui.confirm(
		"No upstream branch",
		`Branch '${branch}' has no upstream. Set it to '${upstream}' and pull?`,
	);
	if (!confirm) {
		notifyCancelled(ctx);
		return false;
	}

	const setResult = await runGit(pi, ctx.cwd, ["branch", `--set-upstream-to=${upstream}`]);
	if (setResult.code !== 0) {
		ctx.ui.notify(`Setting upstream failed: ${describeFailure(setResult)}`, "error");
		return false;
	}
	return true;
}

export async function handleGitPull(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!(await ensureUpstream(pi, ctx))) {
		return;
	}

	const pullResult = await runGit(pi, ctx.cwd, ["pull", "--prune"], GIT_NETWORK_TIMEOUT_MS);
	if (pullResult.code !== 0) {
		// Drop the fetch progress ("From <url>", "a..b main -> origin/main") that precedes the actual error.
		const stderr = pullResult.stderr
			.split("\n")
			.filter((x) => !/^From\s/.test(x) && !/->/.test(x))
			.join("\n");
		ctx.ui.notify(`git pull failed: ${describeFailure({ ...pullResult, stderr }, GIT_NETWORK_TIMEOUT_MS)}`, "error");
		return;
	}

	ctx.ui.notify(`git pull completed. ${summarizePullOutput(pullResult.stdout)}`, "info");
}
