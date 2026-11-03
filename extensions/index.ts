import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";

type BranchInfo = {
	name: string;
	isCurrent: boolean;
	isLocalOnly: boolean;
};

type GitExecResult = {
	code: number;
	stdout: string;
	stderr: string;
};

type AheadBehind = {
	incoming: number;
	outgoing: number;
	hasUpstream: boolean;
};

type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

const GIT_TIMEOUT_MS = 20_000;
const GIT_SYNC_REFRESH_MS = 12_000;

async function runGit(pi: ExtensionAPI, cwd: string, args: string[]): Promise<GitExecResult> {
	return pi.exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
}

async function isGitRepository(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const result = await runGit(pi, cwd, ["rev-parse", "--is-inside-work-tree"]);
	return result.code === 0;
}

async function getCurrentBranch(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const result = await runGit(pi, cwd, ["branch", "--show-current"]);
	if (result.code !== 0) {
		return undefined;
	}
	const name = result.stdout.trim();
	return name || undefined;
}

async function getAheadBehind(pi: ExtensionAPI, cwd: string): Promise<AheadBehind> {
	const upstreamResult = await runGit(pi, cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
	if (upstreamResult.code !== 0) {
		return { incoming: 0, outgoing: 0, hasUpstream: false };
	}

	const countResult = await runGit(pi, cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
	if (countResult.code !== 0) {
		return { incoming: 0, outgoing: 0, hasUpstream: false };
	}

	const parts = countResult.stdout.trim().split(/\s+/);
	const incoming = Number(parts[0] ?? "0");
	const outgoing = Number(parts[1] ?? "0");

	return {
		incoming: Number.isFinite(incoming) ? incoming : 0,
		outgoing: Number.isFinite(outgoing) ? outgoing : 0,
		hasUpstream: true,
	};
}

function remoteRefToBranchName(ref: string): string | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) {
		return undefined;
	}
	const branch = ref.slice(slash + 1);
	if (!branch || branch === "HEAD") {
		return undefined;
	}
	return branch;
}

async function listBranches(pi: ExtensionAPI, cwd: string): Promise<BranchInfo[]> {
	const [localResult, remoteResult, currentResult] = await Promise.all([
		runGit(pi, cwd, ["for-each-ref", "refs/heads", "--format=%(refname:short)"]),
		runGit(pi, cwd, ["for-each-ref", "refs/remotes", "--format=%(refname:short)"]),
		runGit(pi, cwd, ["branch", "--show-current"]),
	]);

	if (localResult.code !== 0) {
		return [];
	}

	const locals = localResult.stdout
		.split("\n")
		.map((x) => x.trim())
		.filter((x) => x.length > 0);

	const remoteBranches = new Set<string>();
	if (remoteResult.code === 0) {
		for (const line of remoteResult.stdout.split("\n")) {
			const remoteRef = line.trim();
			if (!remoteRef) {
				continue;
			}
			const branchName = remoteRefToBranchName(remoteRef);
			if (branchName) {
				remoteBranches.add(branchName);
			}
		}
	}

	const currentBranch = currentResult.code === 0 ? currentResult.stdout.trim() : "";

	return locals.map((name) => ({
		name,
		isCurrent: name === currentBranch,
		isLocalOnly: !remoteBranches.has(name),
	}));
}

async function localBranchExists(pi: ExtensionAPI, cwd: string, branchName: string): Promise<boolean> {
	const result = await runGit(pi, cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
	return result.code === 0;
}

function formatBranchList(branches: BranchInfo[]): string {
	if (branches.length === 0) {
		return "No local branches found.";
	}

	const lines = branches.map((branch) => {
		const currentMark = branch.isCurrent ? ">" : " ";
		const localOnlyMark = branch.isLocalOnly ? "*" : "";
		return `${currentMark} ${branch.name}${localOnlyMark}`;
	});

	return ["Local branches:", ...lines, "", "* = local-only branch (not present on any remote)"]
		.join("\n")
		.trimEnd();
}

function makeBranchItems(branches: BranchInfo[], query: string): AutocompleteItem[] {
	const q = query.trim().toLowerCase();
	const filtered = q
		? branches.filter((b) => b.name.toLowerCase().includes(q))
		: branches;

	return filtered.slice(0, 50).map((branch) => ({
		value: branch.name,
		label: `${branch.name}${branch.isLocalOnly ? "*" : ""}`,
		description: branch.isCurrent
			? "current branch"
			: branch.isLocalOnly
				? "local only"
				: "present on remote",
	}));
}

function createGitAutocompleteProvider(
	current: AutocompleteProvider,
	getBranches: () => Promise<BranchInfo[]>,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const line = lines[cursorLine] ?? "";
			const textBeforeCursor = line.slice(0, cursorCol);

			if (!textBeforeCursor.startsWith("/git")) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const branchMatch = textBeforeCursor.match(/^\/git\s+branch(?:\s+([^\s]*))?$/);
			if (branchMatch) {
				const token = branchMatch[1] ?? "";
				const branches = await getBranches();
				if (options.signal.aborted || branches.length === 0) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}

				const items = makeBranchItems(branches, token);
				if (items.length === 0) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}

				return {
					items,
					prefix: token,
				};
			}

			const subcommandMatch = textBeforeCursor.match(/^\/git\s+([^\s]*)$/);
			if (subcommandMatch) {
				const token = subcommandMatch[1] ?? "";
				const values: AutocompleteItem[] = [
					{ value: "pull", label: "pull", description: "Run fetch + pull" },
					{ value: "branch ", label: "branch", description: "Switch/create local branch" },
				];

				const items = values.filter((x) => x.value.startsWith(token) || x.label.startsWith(token));
				if (items.length === 0) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}

				return {
					items,
					prefix: token,
				};
			}

			return current.getSuggestions(lines, cursorLine, cursorCol, options);
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			const line = lines[cursorLine] ?? "";
			const textBeforeCursor = line.slice(0, cursorCol);
			if (textBeforeCursor.startsWith("/git")) {
				return false;
			}
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function formatTokens(count: number): string {
	if (count < 1000) {
		return `${count}`;
	}
	if (count < 10000) {
		return `${(count / 1000).toFixed(1)}k`;
	}
	if (count < 1000000) {
		return `${Math.round(count / 1000)}k`;
	}
	if (count < 10000000) {
		return `${(count / 1000000).toFixed(1)}M`;
	}
	return `${Math.round(count / 1000000)}M`;
}

function formatCwdForFooter(cwd: string, home?: string): string {
	if (!home) {
		return cwd;
	}
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) {
		return cwd;
	}
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

function addUsage(totals: UsageTotals, usage: any): void {
	if (!usage) {
		return;
	}
	totals.input += Number(usage.input ?? 0);
	totals.output += Number(usage.output ?? 0);
	totals.cacheRead += Number(usage.cacheRead ?? 0);
	totals.cacheWrite += Number(usage.cacheWrite ?? 0);
	totals.cost += Number(usage.cost?.total ?? 0);
}

function getUsageTotalsAndCacheHit(ctx: ExtensionContext): { usageTotals: UsageTotals; latestCacheHitRate?: number } {
	const usageTotals = createUsageTotals();
	let latestCacheHitRate: number | undefined;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "usage") {
			addUsage(usageTotals, (entry as any).usage);
			continue;
		}

		if (entry.type === "message") {
			const message = (entry as any).message;
			if (message?.role === "assistant" && message.usage) {
				addUsage(usageTotals, message.usage);
				const latestPromptTokens =
					Number(message.usage.input ?? 0) + Number(message.usage.cacheRead ?? 0) + Number(message.usage.cacheWrite ?? 0);
				latestCacheHitRate = latestPromptTokens > 0 ? (Number(message.usage.cacheRead ?? 0) / latestPromptTokens) * 100 : undefined;
				continue;
			}

			if (message?.role === "toolResult" && message.usage) {
				addUsage(usageTotals, message.usage);
			}
			continue;
		}

		if ((entry.type === "branch_summary" || entry.type === "compaction") && (entry as any).usage) {
			addUsage(usageTotals, (entry as any).usage);
		}
	}

	return { usageTotals, latestCacheHitRate };
}

async function handleGitPull(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const fetchResult = await runGit(pi, ctx.cwd, ["fetch", "--prune"]);
	if (fetchResult.code !== 0) {
		const details = fetchResult.stderr.trim() || `exit code ${fetchResult.code}`;
		ctx.ui.notify(`git fetch failed: ${details}`, "error");
		return;
	}

	const pullResult = await runGit(pi, ctx.cwd, ["pull"]);
	if (pullResult.code !== 0) {
		const details = pullResult.stderr.trim() || `exit code ${pullResult.code}`;
		ctx.ui.notify(`git pull failed: ${details}`, "error");
		return;
	}

	const summary = pullResult.stdout.trim() || "Update completed.";
	ctx.ui.notify(`fetch + pull completed. ${summary}`, "info");
}

async function handleBranchSwitchOrCreate(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	branchName: string,
): Promise<void> {
	const exists = await localBranchExists(pi, ctx.cwd, branchName);

	if (exists) {
		const checkoutResult = await runGit(pi, ctx.cwd, ["checkout", branchName]);
		if (checkoutResult.code !== 0) {
			const details = checkoutResult.stderr.trim() || `exit code ${checkoutResult.code}`;
			ctx.ui.notify(`Checkout failed: ${details}`, "error");
			return;
		}
		ctx.ui.notify(`Switched to branch '${branchName}'.`, "info");
		return;
	}

	const currentBranch = (await getCurrentBranch(pi, ctx.cwd)) ?? "(detached HEAD)";
	const confirm = await ctx.ui.confirm(
		"Branch not found",
		`Branch '${branchName}' does not exist locally. Create it from '${currentBranch}'?`,
	);
	if (!confirm) {
		ctx.ui.notify("Operation cancelled.", "info");
		return;
	}

	const createResult = await runGit(pi, ctx.cwd, ["checkout", "-b", branchName]);
	if (createResult.code !== 0) {
		const details = createResult.stderr.trim() || `exit code ${createResult.code}`;
		ctx.ui.notify(`Branch creation failed: ${details}`, "error");
		return;
	}

	ctx.ui.notify(`Created and switched to branch '${branchName}' from '${currentBranch}'.`, "info");
}

async function handleGitBranch(pi: ExtensionAPI, ctx: ExtensionCommandContext, branchArg: string): Promise<void> {
	const branchName = branchArg.trim();

	if (!branchName) {
		const branches = await listBranches(pi, ctx.cwd);
		ctx.ui.notify(formatBranchList(branches), "info");
		return;
	}

	await handleBranchSwitchOrCreate(pi, ctx, branchName);
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!(await isGitRepository(pi, ctx.cwd))) {
			return;
		}

		let cache: { at: number; branches: BranchInfo[] } | undefined;
		const getBranches = async (): Promise<BranchInfo[]> => {
			const now = Date.now();
			if (cache && now - cache.at < 2_000) {
				return cache.branches;
			}
			const branches = await listBranches(pi, ctx.cwd);
			cache = { at: now, branches };
			return branches;
		};

		ctx.ui.addAutocompleteProvider((current) => createGitAutocompleteProvider(current, getBranches));

		if (ctx.mode === "tui") {
			ctx.ui.setFooter((tui, theme, footerData) => {
				let disposed = false;
				let sync: AheadBehind = { incoming: 0, outgoing: 0, hasUpstream: false };

				const refresh = async (): Promise<void> => {
					const next = await getAheadBehind(pi, ctx.cwd);
					if (disposed) {
						return;
					}
					sync = next;
					tui.requestRender();
				};

				void refresh();
				const timer = setInterval(() => {
					void refresh();
				}, GIT_SYNC_REFRESH_MS);
				const unsubBranch = footerData.onBranchChange(() => {
					void refresh();
				});

				return {
					dispose() {
						disposed = true;
						clearInterval(timer);
						unsubBranch();
					},
					invalidate() {},
					render(width: number): string[] {
						const contextUsage = ctx.getContextUsage();
						const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
						const contextPercentValue = contextUsage?.percent ?? 0;
						const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

						let pwd = formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
						const branch = footerData.getGitBranch();
						if (branch) {
							const statusPart = sync.hasUpstream ? ` ↓${sync.incoming} ↑${sync.outgoing}` : " ↓0 ↑0";
							pwd = `${pwd} (${branch}${statusPart})`;
						}

						const sessionName = ctx.sessionManager.getSessionName();
						if (sessionName) {
							pwd = `${pwd} • ${sessionName}`;
						}

						const { usageTotals, latestCacheHitRate } = getUsageTotalsAndCacheHit(ctx);
						const statsParts: string[] = [];
						if (usageTotals.input) statsParts.push(`↑${formatTokens(usageTotals.input)}`);
						if (usageTotals.output) statsParts.push(`↓${formatTokens(usageTotals.output)}`);
						if (usageTotals.cacheRead) statsParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
						if (usageTotals.cacheWrite) statsParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
						if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
							statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
						}
						if (usageTotals.cost) {
							statsParts.push(`$${usageTotals.cost.toFixed(3)}`);
						}

						const autoIndicator = " (auto)";
						const contextPercentDisplay =
							contextPercent === "?"
								? `?/${formatTokens(contextWindow)}${autoIndicator}`
								: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;

						let contextPercentStr = contextPercentDisplay;
						if (contextPercentValue > 90) {
							contextPercentStr = theme.fg("error", contextPercentDisplay);
						} else if (contextPercentValue > 70) {
							contextPercentStr = theme.fg("warning", contextPercentDisplay);
						}
						statsParts.push(contextPercentStr);

						let statsLeft = statsParts.join(" ");
						let statsLeftWidth = visibleWidth(statsLeft);
						if (statsLeftWidth > width) {
							statsLeft = truncateToWidth(statsLeft, width, "...");
							statsLeftWidth = visibleWidth(statsLeft);
						}

						const modelName = ctx.model?.id || "no-model";
						let rightSideWithoutProvider = modelName;
						if ((ctx.model as any)?.reasoning) {
							const thinkingLevel = ctx.thinkingLevel || "off";
							rightSideWithoutProvider =
								thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
						}

						let rightSide = rightSideWithoutProvider;
						if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
							rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
							if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) {
								rightSide = rightSideWithoutProvider;
							}
						}

						const rightSideWidth = visibleWidth(rightSide);
						const minPadding = 2;
						const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
						let statsLine: string;

						if (totalNeeded <= width) {
							const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
							statsLine = statsLeft + padding + rightSide;
						} else {
							const availableForRight = width - statsLeftWidth - minPadding;
							if (availableForRight > 0) {
								const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
								const truncatedRightWidth = visibleWidth(truncatedRight);
								const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
								statsLine = statsLeft + padding + truncatedRight;
							} else {
								statsLine = statsLeft;
							}
						}

						const dimStatsLeft = theme.fg("dim", statsLeft);
						const remainder = statsLine.slice(statsLeft.length);
						const dimRemainder = theme.fg("dim", remainder);
						const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

						const lines = [pwdLine, dimStatsLeft + dimRemainder];
						const extensionStatuses = footerData.getExtensionStatuses();
						if (extensionStatuses.size > 0) {
							const sortedStatuses = Array.from(extensionStatuses.entries())
								.sort(([a], [b]) => a.localeCompare(b))
								.map(([, text]) => sanitizeStatusText(text));
							const statusLine = sortedStatuses.join(" ");
							lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
						}

						return lines;
					},
				};
			});
		}
	});

	pi.registerCommand("git", {
		description: "Git helper: /git pull | /git branch [name]",
		handler: async (args, ctx) => {
			if (!(await isGitRepository(pi, ctx.cwd))) {
				ctx.ui.notify("The current directory is not a git repository.", "error");
				return;
			}

			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /git pull | /git branch [name]", "info");
				return;
			}

			if (trimmed === "pull") {
				await handleGitPull(pi, ctx);
				return;
			}

			const branchMatch = trimmed.match(/^branch(?:\s+(.*))?$/);
			if (branchMatch) {
				await handleGitBranch(pi, ctx, branchMatch[1] ?? "");
				return;
			}

			ctx.ui.notify("Unknown command. Use: /git pull or /git branch [name]", "error");
		},
	});
}
