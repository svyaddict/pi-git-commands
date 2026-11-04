import { isAbsolute, relative, resolve, sep } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
	ContextUsage,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";

type BranchInfo = {
	name: string;
	isCurrent: boolean;
	isLocalOnly: boolean;
};

type RemoteBranchInfo = {
	name: string;
	remotes: string[];
};

type BranchListing = {
	locals: BranchInfo[];
	/** Branches that exist on a remote but have no local counterpart. */
	remoteOnly: RemoteBranchInfo[];
};

type GitExecResult = {
	code: number;
	stdout: string;
	stderr: string;
	killed: boolean;
};

type AheadBehind = {
	incoming: number;
	outgoing: number;
	available: boolean;
};

type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

type UsageLike = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
};

type SessionStats = {
	key: string;
	usageTotals: UsageTotals;
	latestCacheHitRate?: number;
	contextUsage?: ContextUsage;
};

const GIT_TIMEOUT_MS = 20_000;
const GIT_NETWORK_TIMEOUT_MS = 120_000;
const GIT_SYNC_REFRESH_MS = 12_000;
const BRANCH_CACHE_MS = 2_000;
const FOOTER_ENV_VAR = "PI_GIT_FOOTER";

async function runGit(
	pi: ExtensionAPI,
	cwd: string,
	args: string[],
	timeout: number = GIT_TIMEOUT_MS,
): Promise<GitExecResult> {
	return pi.exec("git", args, { cwd, timeout });
}

function describeFailure(result: GitExecResult, timeout: number = GIT_TIMEOUT_MS): string {
	if (result.killed) {
		return `timed out after ${Math.round(timeout / 1000)}s`;
	}
	return result.stderr.trim() || `exit code ${result.code}`;
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
async function getAheadBehind(pi: ExtensionAPI, cwd: string): Promise<AheadBehind> {
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

async function getUpstream(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const result = await runGit(pi, cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
	return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

function splitLines(text: string): string[] {
	return text
		.split("\n")
		.map((x) => x.trim())
		.filter((x) => x.length > 0);
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
async function listRemoteBranches(
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

async function listBranches(pi: ExtensionAPI, cwd: string): Promise<BranchListing> {
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

async function localBranchExists(pi: ExtensionAPI, cwd: string, branchName: string): Promise<boolean> {
	const result = await runGit(pi, cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
	return result.code === 0;
}

async function findRemotesWithBranch(pi: ExtensionAPI, cwd: string, branchName: string): Promise<string[]> {
	const { byBranch } = await listRemoteBranches(pi, cwd);
	return byBranch.get(branchName) ?? [];
}

/**
 * Validate a user-supplied branch name. Returns the normalized name (git expands
 * shorthands such as `@{-1}`) or an error message.
 */
async function validateBranchName(
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

function makeBranchItems(listing: BranchListing, query: string): AutocompleteItem[] {
	const q = query.trim().toLowerCase();
	const matches = (name: string) => !q || name.toLowerCase().includes(q);

	const localItems: AutocompleteItem[] = listing.locals
		.filter((b) => matches(b.name))
		.map((branch) => ({
			value: branch.name,
			label: `${branch.name}${branch.isLocalOnly ? "*" : ""}`,
			description: branch.isCurrent
				? "current branch"
				: branch.isLocalOnly
					? "local only"
					: "present on remote",
		}));

	const remoteItems: AutocompleteItem[] = listing.remoteOnly
		.filter((b) => matches(b.name))
		.map((branch) => ({
			value: branch.name,
			label: branch.name,
			description: `remote only (${branch.remotes.join(", ")})`,
		}));

	return [...localItems, ...remoteItems].slice(0, 50);
}

function isGitCommandInput(text: string): boolean {
	return /^\/git(?:\s|$)/.test(text);
}

function createGitAutocompleteProvider(
	current: AutocompleteProvider,
	getBranches: () => Promise<BranchListing>,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const line = lines[cursorLine] ?? "";
			const textBeforeCursor = line.slice(0, cursorCol);

			if (!isGitCommandInput(textBeforeCursor)) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const branchMatch = textBeforeCursor.match(/^\/git\s+branch\s+(\S*)$/);
			if (branchMatch) {
				const token = branchMatch[1] ?? "";
				const listing = await getBranches();
				if (options.signal.aborted) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}

				const items = makeBranchItems(listing, token);
				if (items.length === 0) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}

				return {
					items,
					prefix: token,
				};
			}

			const subcommandMatch = textBeforeCursor.match(/^\/git\s+(\S*)$/);
			if (subcommandMatch) {
				const token = subcommandMatch[1] ?? "";
				const values: AutocompleteItem[] = [
					{ value: "pull", label: "pull", description: "Run git pull --prune" },
					// Trailing space: completing it leads straight into branch-name suggestions.
					{ value: "branch ", label: "branch", description: "List, switch or create branches" },
				];

				const items = values.filter((x) => x.value.startsWith(token));
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
			if (isGitCommandInput(textBeforeCursor)) {
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

function addUsage(totals: UsageTotals, usage: UsageLike | undefined): void {
	if (!usage) {
		return;
	}
	totals.input += Number(usage.input ?? 0);
	totals.output += Number(usage.output ?? 0);
	totals.cacheRead += Number(usage.cacheRead ?? 0);
	totals.cacheWrite += Number(usage.cacheWrite ?? 0);
	totals.cost += Number(usage.cost?.total ?? 0);
}

function computeUsageTotals(entries: SessionEntry[]): { usageTotals: UsageTotals; latestCacheHitRate?: number } {
	const usageTotals = createUsageTotals();
	let latestCacheHitRate: number | undefined;

	for (const entry of entries) {
		if (entry.type === "usage") {
			addUsage(usageTotals, entry.usage);
			continue;
		}

		if (entry.type === "message") {
			const message = entry.message as { role?: string; usage?: UsageLike };
			if (message.role === "assistant" && message.usage) {
				addUsage(usageTotals, message.usage);
				const cacheRead = Number(message.usage.cacheRead ?? 0);
				const latestPromptTokens =
					Number(message.usage.input ?? 0) + cacheRead + Number(message.usage.cacheWrite ?? 0);
				latestCacheHitRate = latestPromptTokens > 0 ? (cacheRead / latestPromptTokens) * 100 : undefined;
				continue;
			}

			if (message.role === "toolResult" && message.usage) {
				addUsage(usageTotals, message.usage);
			}
			continue;
		}

		if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addUsage(usageTotals, entry.usage);
		}
	}

	return { usageTotals, latestCacheHitRate };
}

/**
 * Usage totals scan the whole session, and the footer renders on every frame. Entries are
 * append-only and every append moves the leaf, so the stats only change with the session,
 * the leaf or the model whose context window applies.
 */
function createSessionStatsReader(ctx: ExtensionContext): () => SessionStats {
	let cached: SessionStats | undefined;
	return () => {
		const model = ctx.model;
		const key = [
			ctx.sessionManager.getSessionId(),
			ctx.sessionManager.getLeafId() ?? "",
			model ? `${model.provider}/${model.id}` : "",
		].join("\u0000");
		if (cached && cached.key === key) {
			return cached;
		}
		const { usageTotals, latestCacheHitRate } = computeUsageTotals(ctx.sessionManager.getEntries());
		cached = { key, usageTotals, latestCacheHitRate, contextUsage: ctx.getContextUsage() };
		return cached;
	};
}

function readAutoCompactEnabled(ctx: ExtensionContext): boolean {
	try {
		return SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() }).getCompactionEnabled();
	} catch {
		return true;
	}
}

function isUsingSubscription(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	if (!model) {
		return false;
	}
	// Kimi Coding is subscription-backed despite using API-key authentication.
	if (model.provider === "kimi-coding") {
		return true;
	}
	try {
		return (
			ctx.modelRegistry.isUsingOAuth(model) &&
			ctx.modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription === true
		);
	} catch {
		return false;
	}
}

function isFooterDisabled(): boolean {
	const value = process.env[FOOTER_ENV_VAR]?.trim().toLowerCase();
	return value === "0" || value === "off" || value === "false" || value === "no";
}

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
				`Push it first, e.g. git push -u origin ${branch}`,
			"warning",
		);
		return false;
	}

	const remote = await pickRemote(ctx, branch, remotes);
	if (!remote) {
		ctx.ui.notify("Operation cancelled.", "info");
		return false;
	}

	const upstream = `${remote}/${branch}`;
	const confirm = await ctx.ui.confirm(
		"No upstream branch",
		`Branch '${branch}' has no upstream. Set it to '${upstream}' and pull?`,
	);
	if (!confirm) {
		ctx.ui.notify("Operation cancelled.", "info");
		return false;
	}

	const setResult = await runGit(pi, ctx.cwd, ["branch", `--set-upstream-to=${upstream}`]);
	if (setResult.code !== 0) {
		ctx.ui.notify(`Setting upstream failed: ${describeFailure(setResult)}`, "error");
		return false;
	}
	return true;
}

async function handleGitPull(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
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
		ctx.ui.notify(
			`git pull failed: ${describeFailure({ ...pullResult, stderr }, GIT_NETWORK_TIMEOUT_MS)}`,
			"error",
		);
		return;
	}

	ctx.ui.notify(`git pull completed. ${summarizePullOutput(pullResult.stdout)}`, "info");
}

async function pickRemote(ctx: ExtensionCommandContext, branchName: string, remotes: string[]): Promise<string | undefined> {
	if (remotes.length === 1) {
		return remotes[0];
	}
	return ctx.ui.select(`Branch '${branchName}' exists on several remotes. Track which one?`, remotes);
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
		const remote = await pickRemote(ctx, branchName, remotes);
		if (!remote) {
			ctx.ui.notify("Operation cancelled.", "info");
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
		ctx.ui.notify("Operation cancelled.", "info");
		return;
	}

	const createResult = await runGit(pi, ctx.cwd, ["switch", "--create", branchName]);
	if (createResult.code !== 0) {
		ctx.ui.notify(`Branch creation failed: ${describeFailure(createResult)}`, "error");
		return;
	}

	ctx.ui.notify(`Created and switched to branch '${branchName}' from '${currentBranch}'.`, "info");
}

async function handleGitBranch(pi: ExtensionAPI, ctx: ExtensionCommandContext, branchArg: string): Promise<void> {
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

export default function (pi: ExtensionAPI): void {
	/** Set by the footer while it is mounted, so commands can refresh the counters right away. */
	let requestSyncRefresh: (() => void) | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (!(await isGitRepository(pi, ctx.cwd))) {
			return;
		}

		let cache: { at: number; listing: BranchListing } | undefined;
		const getBranches = async (): Promise<BranchListing> => {
			const now = Date.now();
			if (cache && now - cache.at < BRANCH_CACHE_MS) {
				return cache.listing;
			}
			const listing = await listBranches(pi, ctx.cwd);
			cache = { at: now, listing };
			return listing;
		};

		ctx.ui.addAutocompleteProvider((current) => createGitAutocompleteProvider(current, getBranches));

		if (ctx.mode !== "tui" || isFooterDisabled()) {
			return;
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			let disposed = false;
			let sync: AheadBehind = { incoming: 0, outgoing: 0, available: false };
			let autoCompactEnabled = readAutoCompactEnabled(ctx);
			const getSessionStats = createSessionStatsReader(ctx);

			const refresh = async (): Promise<void> => {
				const next = await getAheadBehind(pi, ctx.cwd);
				if (disposed) {
					return;
				}
				sync = next;
				autoCompactEnabled = readAutoCompactEnabled(ctx);
				tui.requestRender();
			};

			void refresh();
			const timer = setInterval(() => {
				void refresh();
			}, GIT_SYNC_REFRESH_MS);
			const unsubBranch = footerData.onBranchChange(() => {
				void refresh();
			});
			requestSyncRefresh = () => {
				void refresh();
			};

			return {
				dispose() {
					disposed = true;
					clearInterval(timer);
					unsubBranch();
					requestSyncRefresh = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const { usageTotals, latestCacheHitRate, contextUsage } = getSessionStats();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent =
						contextUsage && contextUsage.percent !== null ? contextPercentValue.toFixed(1) : "?";

					let pwd = formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
					const branch = footerData.getGitBranch();
					if (branch) {
						const statusPart = sync.available ? ` ↓${sync.incoming} ↑${sync.outgoing}` : "";
						pwd = `${pwd} (${branch}${statusPart})`;
					}

					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) {
						pwd = `${pwd} • ${sessionName}`;
					}

					const statsParts: string[] = [];
					if (usageTotals.input) statsParts.push(`↑${formatTokens(usageTotals.input)}`);
					if (usageTotals.output) statsParts.push(`↓${formatTokens(usageTotals.output)}`);
					if (usageTotals.cacheRead) statsParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
					if (usageTotals.cacheWrite) statsParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
					if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
						statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					}
					const usingSubscription = isUsingSubscription(ctx);
					if (usageTotals.cost || usingSubscription) {
						statsParts.push(`$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
					}

					const autoIndicator = autoCompactEnabled ? " (auto)" : "";
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
					if (ctx.model?.reasoning) {
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
				requestSyncRefresh?.();
				return;
			}

			const branchMatch = trimmed.match(/^branch(?:\s+(.*))?$/);
			if (branchMatch) {
				await handleGitBranch(pi, ctx, branchMatch[1] ?? "");
				requestSyncRefresh?.();
				return;
			}

			ctx.ui.notify("Unknown command. Use: /git pull or /git branch [name]", "error");
		},
	});
}
