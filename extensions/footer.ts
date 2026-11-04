import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AheadBehind } from "./git.ts";
import { getAheadBehind } from "./git.ts";
import { createSessionStatsReader, formatTokens } from "./usage.ts";

const GIT_SYNC_REFRESH_MS = 12_000;
const FOOTER_ENV_VAR = "PI_GIT_FOOTER";

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
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

function readAutoCompactEnabled(ctx: ExtensionContext): boolean {
	try {
		return SettingsManager.create(ctx.cwd, undefined, {
			projectTrusted: ctx.isProjectTrusted(),
		}).getCompactionEnabled();
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

export function isFooterDisabled(): boolean {
	const value = process.env[FOOTER_ENV_VAR]?.trim().toLowerCase();
	return value === "0" || value === "off" || value === "false" || value === "no";
}

/**
 * Replace pi's footer with a git-aware one. `onRefresher` receives a function that refreshes
 * the ahead/behind counters right away while the footer is mounted, and `undefined` once it
 * is disposed.
 */
export function installGitFooter(
	ctx: ExtensionContext,
	onRefresher: (refresh: (() => void) | undefined) => void,
): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		let disposed = false;
		let sync: AheadBehind = { incoming: 0, outgoing: 0, available: false };
		let autoCompactEnabled = readAutoCompactEnabled(ctx);
		const getSessionStats = createSessionStatsReader(ctx);

		const refresh = async (): Promise<void> => {
			const next = await getAheadBehind(ctx.cwd);
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
		onRefresher(() => {
			void refresh();
		});

		return {
			dispose() {
				disposed = true;
				clearInterval(timer);
				unsubBranch();
				onRefresher(undefined);
			},
			invalidate() {},
			render(width: number): string[] {
				const { usageTotals, latestCacheHitRate, contextUsage } = getSessionStats();
				const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const contextPercentValue = contextUsage?.percent ?? 0;
				const contextPercent = contextUsage && contextUsage.percent !== null ? contextPercentValue.toFixed(1) : "?";

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
}
