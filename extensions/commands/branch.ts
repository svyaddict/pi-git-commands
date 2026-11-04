import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { BranchInfo } from "../git.ts";
import {
	describeFailure,
	findRemotesWithBranch,
	getCurrentBranch,
	listBranches,
	localBranchExists,
	runGit,
	validateBranchName,
} from "../git.ts";
import { notifyCancelled, pickRemote } from "./shared.ts";

function formatBranchList(branches: BranchInfo[]): string {
	if (branches.length === 0) {
		return "No local branches found.";
	}

	const lines = branches.map((branch) => {
		const currentMark = branch.isCurrent ? ">" : " ";
		const localOnlyMark = branch.isLocalOnly ? "*" : "";
		return `${currentMark} ${branch.name}${localOnlyMark}`;
	});

	return ["Local branches:", ...lines, "", "* = local-only branch (not present on any remote)"].join("\n").trimEnd();
}

async function handleBranchSwitchOrCreate(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	branchName: string,
): Promise<void> {
	if (await localBranchExists(pi, ctx.cwd, branchName)) {
		const switchResult = await runGit(pi, ctx.cwd, ["switch", branchName]);
		if (switchResult.code !== 0) {
			ctx.ui.notify(`Switch failed: ${describeFailure(switchResult)}`, "error");
			return;
		}
		ctx.ui.notify(`Switched to branch '${branchName}'.`, "info");
		return;
	}

	const remotes = await findRemotesWithBranch(pi, ctx.cwd, branchName);
	if (remotes.length > 0) {
		const remote = await pickRemote(ctx, `Branch '${branchName}' exists on several remotes. Track which one?`, remotes);
		if (!remote) {
			notifyCancelled(ctx);
			return;
		}
		const upstream = `${remote}/${branchName}`;
		const trackResult = await runGit(pi, ctx.cwd, ["switch", "--create", branchName, "--track", upstream]);
		if (trackResult.code !== 0) {
			ctx.ui.notify(`Switch failed: ${describeFailure(trackResult)}`, "error");
			return;
		}
		ctx.ui.notify(`Created branch '${branchName}' tracking '${upstream}' and switched to it.`, "info");
		return;
	}

	const currentBranch = (await getCurrentBranch(pi, ctx.cwd)) ?? "(detached HEAD)";
	const confirm = await ctx.ui.confirm(
		"Branch not found",
		`Branch '${branchName}' does not exist locally or on any remote. Create it from '${currentBranch}'?`,
	);
	if (!confirm) {
		notifyCancelled(ctx);
		return;
	}

	const createResult = await runGit(pi, ctx.cwd, ["switch", "--create", branchName]);
	if (createResult.code !== 0) {
		ctx.ui.notify(`Branch creation failed: ${describeFailure(createResult)}`, "error");
		return;
	}

	ctx.ui.notify(`Created and switched to branch '${branchName}' from '${currentBranch}'.`, "info");
}

export async function handleGitBranch(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	branchArg: string,
): Promise<void> {
	const input = branchArg.trim();

	if (!input) {
		const listing = await listBranches(pi, ctx.cwd);
		ctx.ui.notify(formatBranchList(listing.locals), "info");
		return;
	}

	const validated = await validateBranchName(pi, ctx.cwd, input);
	if ("error" in validated) {
		ctx.ui.notify(validated.error, "error");
		return;
	}

	await handleBranchSwitchOrCreate(pi, ctx, validated.name);
}
