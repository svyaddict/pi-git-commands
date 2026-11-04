import type { ContextUsage, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export type UsageTotals = {
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

export type SessionStats = {
	key: string;
	usageTotals: UsageTotals;
	latestCacheHitRate?: number;
	contextUsage?: ContextUsage;
};

export function formatTokens(count: number): string {
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
				const latestPromptTokens = Number(message.usage.input ?? 0) + cacheRead + Number(message.usage.cacheWrite ?? 0);
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
export function createSessionStatsReader(ctx: ExtensionContext): () => SessionStats {
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
