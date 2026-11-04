import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { GIT_NETWORK_TIMEOUT_MS, describeFailure, getAheadBehind, getCurrentBranch, runGit } from "../git.ts";
import { plural } from "./shared.ts";

export async function handleGitFetch(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const fetchResult = await runGit(pi, ctx.cwd, ["fetch", "--all", "--prune"], GIT_NETWORK_TIMEOUT_MS);
	if (fetchResult.code !== 0) {
		ctx.ui.notify(`git fetch failed: ${describeFailure(fetchResult, GIT_NETWORK_TIMEOUT_MS)}`, "error");
		return;
	}

	const parts = ["git fetch completed."];

	// Pruned refs are reported on stderr as " - [deleted]         (none)     -> origin/x".
	const pruned = fetchResult.stderr.split("\n").filter((x) => /\[deleted\]/.test(x)).length;
	if (pruned > 0) {
		parts.push(`Pruned ${plural(pruned, "stale remote-tracking branch", "stale remote-tracking branches")}.`);
	}

	const [branch, sync] = await Promise.all([getCurrentBranch(pi, ctx.cwd), getAheadBehind(pi, ctx.cwd)]);
	if (branch && sync.available) {
		if (sync.incoming > 0) {
			parts.push(`'${branch}' is ${plural(sync.incoming, "commit")} behind: run /git pull to update.`);
		} else {
			parts.push(`'${branch}' has no incoming commits.`);
		}
	}

	ctx.ui.notify(parts.join(" "), "info");
}
