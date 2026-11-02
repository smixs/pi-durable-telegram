import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("INF-18: a packed asset installs all four fixes into a clean npm project", { timeout: 120_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdt-inf18-install-"));
	const npm = (args: string[], cwd: string) =>
		execFileSync("npm", args, { cwd, encoding: "utf8", timeout: 90_000, stdio: "pipe" });
	try {
		await writeFile(join(dir, "package.json"), JSON.stringify({ private: true }));
		const packed = npm(["pack", "--pack-destination", dir, "--json"], repo);
		const result = (JSON.parse(packed.slice(packed.indexOf("["))) as { filename: string }[])[0];
		assert.ok(result);
		npm(["install", join(dir, result.filename), "--no-audit", "--no-fund", "--foreground-scripts"], dir);
		const installed = join(dir, "node_modules/pi-durable-telegram");
		const read = (path: string) => readFileSync(join(installed, path), "utf8");
		assert.match(read("dist/delivery/wait-phase.js"), /whenBusy: "steer"/);
		assert.match(read("dist/agent/settings.js"), /maxRetries: 5, baseDelayMs: 5000, maxAgentDelayMs: 60000/);
		assert.match(
			read("dist/channel/handlers.js"),
			/liveRun === undefined[\s\S]*?draft_stop_idle_ignored[\s\S]*?return;/,
		);
		const installedRequire = createRequire(join(installed, "package.json"));
		const target = join(dirname(installedRequire.resolve("@earendil-works/pi-durable")), "harness/generation.js");
		const patched = readFileSync(target, "utf8");
		assert.match(patched, /attempt <= 3/);
		assert.match(patched, /authRotation \? 10000 \* 2 \*\* \(attempt - 1\)/);
		const local = join(dirname(require.resolve("@earendil-works/pi-durable")), "harness/generation.js");
		assert.equal(
			hash(patched),
			hash(readFileSync(local, "utf8")),
			"installed retry code equals the runtime-tested code",
		);
		npm(["run", "postinstall"], installed);
		assert.equal(readFileSync(target, "utf8"), patched, "the patch is idempotent");
		await writeFile(target, `${patched}\n// unexpected upstream change\n`);
		assert.throws(() => npm(["run", "postinstall"], installed), /unexpected generation.js/);
		assert.equal(
			readFileSync(target, "utf8"),
			`${patched}\n// unexpected upstream change\n`,
			"an unknown source stays intact",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
