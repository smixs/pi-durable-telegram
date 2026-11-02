// Version-pinned upstream patch: no fork and no patch-tool runtime dependency.
// Resolve from this package so both hoisted and nested npm dependencies work.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = dirname(dirname(require.resolve("@earendil-works/pi-durable")));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (manifest.version !== "1.5.0") throw new Error(`INF-18: unsupported pi-durable ${manifest.version}`);
const target = join(root, "dist/harness/generation.js");
const source = readFileSync(target, "utf8");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const originalSha = "65a11a5164ffdb95b2031c3ae937da848a8897e57d1823ff34f97692eec7c570";
const patchedSha = "a1048982ff19be2e109766d0ba858e65c973ff8f00253f29aebd1717f53e0e1c";
const before =
	'    // An overflow is never retried: only a compaction can make the next request fit.\n    const retry = message.stopReason === "error" &&\n        !overflow &&\n        isRetryableAssistantError(message) &&\n        policy.enabled &&\n        attempt <= policy.maxRetries;\n    const until = retry ? runtime.now() + retryDelayMs(policy, attempt) : 0;\n';
const after =
	'    // An overflow is never retried: only a compaction can make the next request fit.\n    // INF-18: allow the external OAuth owner to rotate access during 10/20/40 s backoffs.\n    const authRotation = message.stopReason === "error" &&\n        !overflow &&\n        /\\b401\\b[\\s\\S]*\\b(authentication_error|revoked|expired)\\b|\\baccess token has been revoked\\b/i.test(message.errorMessage ?? "") &&\n        attempt <= 3;\n    const retry = policy.enabled && (authRotation || (message.stopReason === "error" &&\n        !overflow &&\n        isRetryableAssistantError(message) &&\n        attempt <= policy.maxRetries));\n    const until = retry ? runtime.now() + (authRotation ? 10000 * 2 ** (attempt - 1) : retryDelayMs(policy, attempt)) : 0;\n';

if (sha(source) === patchedSha) {
	console.log("INF-18: pi-durable 1.5.0 auth retry patch already applied");
} else {
	if (sha(source) !== originalSha) throw new Error("INF-18: unexpected generation.js; refusing to patch");
	const patched = source.replace(before, after);
	if (sha(patched) !== patchedSha) throw new Error("INF-18: patched generation.js checksum mismatch");
	writeFileSync(target, patched);
	console.log("INF-18: applied pi-durable 1.5.0 auth retry patch");
}
