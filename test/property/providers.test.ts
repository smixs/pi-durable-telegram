import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { loadProvider } from "../../src/agent/providers.ts";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pdt-providers-test-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.CUSTOM_TEST_API_KEY;
	rmSync(tempDir, { recursive: true, force: true });
});

test("loadProvider returns built-in providers", async () => {
	const anthropic = await loadProvider("anthropic");
	assert.ok(anthropic);
	assert.equal(anthropic.id, "anthropic");

	const deepseek = await loadProvider("deepseek");
	assert.ok(deepseek);
	assert.equal(deepseek.id, "deepseek");
});

test("loadProvider loads custom provider from models.json", async () => {
	const modelsConfig = {
		providers: {
			"custom.llm-v1": {
				name: "Custom LLM",
				baseUrl: "http://127.0.0.1:8000/v1",
				api: "openai-completions",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: models.json literal env interpolation syntax
				apiKey: "${CUSTOM_TEST_API_KEY}",
				models: [
					{
						id: "custom-model",
						name: "Custom Model",
						reasoning: true,
						contextWindow: 64000,
						maxTokens: 4096,
					},
				],
			},
		},
	};
	writeFileSync(join(tempDir, "models.json"), JSON.stringify(modelsConfig), "utf8");
	process.env.CUSTOM_TEST_API_KEY = "test-secret-key";

	const provider = await loadProvider("custom.llm-v1");
	assert.ok(provider);
	assert.equal(provider.id, "custom.llm-v1");
	assert.equal(provider.name, "Custom LLM");
	assert.equal(provider.baseUrl, "http://127.0.0.1:8000/v1");

	const models = provider.getModels();
	assert.equal(models.length, 1);
	assert.equal(models[0]?.id, "custom-model");
	assert.equal(models[0]?.contextWindow, 64000);

	const resolved = await provider.auth?.apiKey?.resolve({
		ctx: {
			env: async (name: string) => process.env[name],
			fileExists: async () => false,
		},
		signal: new AbortController().signal,
	});
	assert.deepEqual(resolved, { auth: { apiKey: "test-secret-key" }, source: "CUSTOM_TEST_API_KEY" });
});

test("loadProvider returns undefined for unknown provider", async () => {
	assert.equal(await loadProvider("non-existent-provider-id"), undefined);
});
