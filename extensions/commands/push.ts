import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GitExecResult } from "../git.ts";
import {
	describeFailure,
	GIT_NETWORK_TIMEOUT_MS,
	getCurrentBranch,
	getUpstream,
	listRemoteBranches,
	runGit,
} from "../git.ts";
import { notifyCancelled, pickRemote } from "./shared.ts";

function describePushFailure(result: GitExecResult): string {
	if (!result.killed && /\[rejected\]/.test(result.stderr)) {
		return "the remote has commits that you do not have locally. Run /git pull first, then push again.";
	}
	// Keep git's error lines; drop the "To <url>" header and the long multi-line hints.
	const stderr = result.stderr
		.split("\n")
		.filter((x) => !/^To\s/.test(x) && !/^hint:/.test(x))
		.join("\n");
	return describeFailure({ ...result, stderr }, GIT_NETWORK_TIMEOUT_MS);
}

/**
 * Choose where a branch without upstream should be pushed: a remote that already has a
 * same-named branch, otherwise any remote (origin first). Asks when there is a choice.
 */
async function chooseTargetRemote(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	branch: string,
): Promise<string | undefined | null> {
	const { remotes, byBranch } = await listRemoteBranches(pi, ctx.cwd);
	if (remotes.length === 0) {
		return null;
	}
	const owners = byBranch.get(branch) ?? [];
	const candidates = owners.length > 0 ? owners : remotes;
	const ordered = [...candidates].sort((a, b) => Number(b === "origin") - Number(a === "origin"));
	return pickRemote(ctx, `Push '${branch}' to which remote?`, ordered);
}

export async function handleGitPush(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const branch = await getCurrentBranch(pi, ctx.cwd);
	if (!branch) {
		ctx.ui.notify("git push is not possible on a detached HEAD. Switch to a branch first.", "warning");
		return;
	}

	const upstream = await getUpstream(pi, ctx.cwd);
	let args: string[];
	let target: string;

	if (upstream) {
		args = ["push"];
		target = upstream;
	} else {
		const remote = await chooseTargetRemote(pi, ctx, branch);
		if (remote === null) {
			ctx.ui.notify("This repository has no remotes to push to. Add one with git remote add.", "warning");
			return;
		}
		if (!remote) {
			notifyCancelled(ctx);
			return;
		}
		target = `${remote}/${branch}`;
		const confirm = await ctx.ui.confirm(
			"No upstream branch",
			`Branch '${branch}' has no upstream. Push it to '${target}' and set it as upstream?`,
		);
		if (!confirm) {
			notifyCancelled(ctx);
			return;
		}
		args = ["push", "--set-upstream", remote, branch];
	}

	const pushResult = await runGit(pi, ctx.cwd, args, GIT_NETWORK_TIMEOUT_MS);
	if (pushResult.code !== 0) {
		ctx.ui.notify(`git push failed: ${describePushFailure(pushResult)}`, "error");
		return;
	}

	// git push reports progress and results on stderr.
	if (/Everything up-to-date/i.test(pushResult.stderr)) {
		ctx.ui.notify(`Nothing to push: '${branch}' is up to date with '${target}'.`, "info");
		return;
	}
	ctx.ui.notify(`Pushed '${branch}' to '${target}'.`, "info");
}
