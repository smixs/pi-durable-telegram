import type { HarnessSettings } from "@earendil-works/pi-durable";

/** How often streamed partials are committed; Telegram shows about one edit per second anyway. */
export const PARTIAL_INTERVAL_MS = 300;

/** pi-durable's defaults for the thresholds a cap scales down (harness `DEFAULT_COMPACTION_POLICY`). */
const DEFAULT_BACKGROUND_TOKENS = 32768;
const DEFAULT_KEEP_RECENT_TOKENS = 20000;

/**
 * Harness settings. `contextCap` limits the context the model works with: blocking compaction starts at the cap (by
 * keeping `contextWindow - contextCap` tokens in reserve), background compaction at most a quarter below it, and a
 * compaction keeps at most a third of the cap, so a compacted context stays under both thresholds.
 */
export function createSettings(options: { contextCap?: number; contextWindow?: number } = {}): HarnessSettings {
	const { contextCap, contextWindow } = options;
	const capped = contextCap !== undefined && contextWindow !== undefined && contextCap < contextWindow;
	return {
		progress: { partialIntervalMs: PARTIAL_INTERVAL_MS, outputIntervalMs: 500 },
		// Per-minute provider limits need a longer window: 5/10/20/40/60 seconds.
		retry: { enabled: true, maxRetries: 5, baseDelayMs: 5000, maxAgentDelayMs: 60000 },
		...(capped ? { compaction: cappedCompaction(contextCap, contextWindow) } : {}),
	};
}

function cappedCompaction(cap: number, window: number) {
	return {
		reserveTokens: window - cap,
		keepRecentTokens: Math.min(DEFAULT_KEEP_RECENT_TOKENS, Math.floor(cap / 3)),
		backgroundTokens: Math.min(DEFAULT_BACKGROUND_TOKENS, Math.floor(cap / 4)),
	};
}
