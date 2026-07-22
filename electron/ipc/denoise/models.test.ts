import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("resolveDenoiseModelPaths", () => {
	let tempRoot: string;
	let appPath: string;

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-denoise-models-"));
		appPath = path.join(tempRoot, "App");
		await fs.mkdir(appPath, { recursive: true });

		vi.resetModules();
		vi.doMock("electron", () => ({
			app: {
				isPackaged: false,
				getAppPath: () => appPath,
			},
		}));
	});

	afterEach(async () => {
		vi.resetModules();
		vi.doUnmock("electron");
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("only trusts a bundled model file whose sha256 matches the expected hash", async () => {
		const { DENOISE_MODEL_FILES, getBundledDenoiseModelPath, resolveDenoiseModelPaths } =
			await import("./models");

		const shPath = getBundledDenoiseModelPath("sh");
		const bdPath = getBundledDenoiseModelPath("bd");
		await fs.mkdir(path.dirname(shPath), { recursive: true });

		const goodContent = Buffer.from("a valid rnnoise model payload");
		await fs.writeFile(shPath, goodContent);
		DENOISE_MODEL_FILES.sh.sha256 = createHash("sha256").update(goodContent).digest("hex");

		const tamperedContent = Buffer.from("a tampered rnnoise model payload");
		await fs.writeFile(bdPath, tamperedContent);
		DENOISE_MODEL_FILES.bd.sha256 = createHash("sha256")
			.update(Buffer.from("something-else"))
			.digest("hex");

		const resolved = await resolveDenoiseModelPaths();
		expect(resolved.sh).toBe(shPath);
		expect(resolved.bd).toBeUndefined();
	});

	it("omits a model entirely when its file is missing from disk", async () => {
		const { resolveDenoiseModelPaths } = await import("./models");
		const resolved = await resolveDenoiseModelPaths();
		expect(resolved.sh).toBeUndefined();
		expect(resolved.bd).toBeUndefined();
	});
});
