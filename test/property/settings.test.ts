import assert from "node:assert/strict";
import { test } from "node:test";
import { retryDelayMs } from "@earendil-works/pi-ai/utils/retry";
import fc from "fast-check";
import { createSettings } from "../../src/agent/settings.ts";
import { check } from "../helpers/property.ts";

// pi-durable's defaults, merged under ours (harness/agent.js DEFAULT_COMPACTION_POLICY).
const DEFAULTS = { reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 };

test("INF-18: per-minute provider limits get five retries over 135 seconds", () => {
	const policy = createSettings().retry;
	assert.deepEqual(policy, { enabled: true, maxRetries: 5, baseDelayMs: 5000, maxAgentDelayMs: 60000 });
	assert.deepEqual(
		[1, 2, 3, 4, 5].map((attempt) => retryDelayMs(policy as never, attempt)),
		[5000, 10000, 20000, 40000, 60000],
	);
});

test("PI_CONTEXT_CAP: compaction never starts far below the cap, and a compacted context does not re-trigger it", (t) => {
	const capAndWindow = fc
		.integer({ min: 1001, max: 2_000_000 })
		.chain((window) => fc.tuple(fc.integer({ min: 1000, max: window - 1 }), fc.constant(window)));
	check(t, capAndWindow, ([cap, window]) => {
		const policy = { ...DEFAULTS, ...createSettings({ contextCap: cap, contextWindow: window }).compaction };
		const blocking = window - policy.reserveTokens;
		const background = blocking - policy.backgroundTokens;
		assert.equal(blocking, cap, "blocking compaction at the cap");
		assert.ok(background >= cap * 0.75, `background compaction at ${background} for cap ${cap}`);
		assert.ok(policy.keepRecentTokens < background, "what compaction keeps stays under the background threshold");
		assert.ok(policy.keepRecentTokens > 0);
		return true;
	});
});

test("PI_CONTEXT_CAP: a large cap keeps pi-durable's defaults; no cap changes nothing", () => {
	const policy = createSettings({ contextCap: 400_000, contextWindow: 1_000_000 }).compaction;
	assert.deepEqual(policy, { reserveTokens: 600_000, keepRecentTokens: 20000, backgroundTokens: 32768 });
	assert.equal(createSettings({ contextWindow: 1_000_000 }).compaction, undefined);
	assert.equal(createSettings({ contextCap: 2_000_000, contextWindow: 1_000_000 }).compaction, undefined);
});
