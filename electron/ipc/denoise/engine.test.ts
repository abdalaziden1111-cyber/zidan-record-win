import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { denoiseAudioFile, measureAudioStats } from "./engine";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ffmpegPath = path.join(
	repoRoot,
	"node_modules",
	"ffmpeg-static",
	process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
);
const modelDir = path.join(repoRoot, "electron", "native", "denoise-models");
const modelPaths = {
	sh: path.join(modelDir, "sh.rnnn"),
	bd: path.join(modelDir, "bd.rnnn"),
} as const;

const hasFixturesToolchain = existsSync(ffmpegPath) && existsSync(modelPaths.sh);

/**
 * Objective end-to-end tests against the real bundled ffmpeg: generate known
 * noise fixtures, denoise them, and assert the measured RMS drop in dB.
 * Skipped automatically when the ffmpeg-static binary was not downloaded
 * (e.g. npm install --ignore-scripts without the follow-up install step).
 */
describe.skipIf(!hasFixturesToolchain)("denoise engine (live ffmpeg)", () => {
	let workDir: string;
	let hissPath: string;
	let noisePath: string;
	let silentVideoPath: string;

	async function generate(args: string[]): Promise<void> {
		await execFileAsync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
			timeout: 60_000,
		});
	}

	async function rmsOf(filePath: string): Promise<number> {
		const stats = await measureAudioStats({ ffmpegPath, inputPath: filePath });
		expect(stats.hasAudio).toBe(true);
		expect(stats.rmsLevelDb).not.toBeNull();
		return stats.rmsLevelDb as number;
	}

	beforeAll(async () => {
		workDir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-denoise-test-"));
		hissPath = path.join(workDir, "hiss.wav");
		noisePath = path.join(workDir, "noise.wav");
		silentVideoPath = path.join(workDir, "silent.mp4");

		// Quiet broadband hiss (fan/AC bleed, ≈ -45 dB RMS).
		await generate([
			"-f",
			"lavfi",
			"-i",
			"anoisesrc=duration=3:color=white:amplitude=0.01",
			"-ar",
			"48000",
			"-ac",
			"1",
			hissPath,
		]);
		// Loud broadband noise (≈ -27 dB RMS).
		await generate([
			"-f",
			"lavfi",
			"-i",
			"anoisesrc=duration=3:color=white:amplitude=0.08",
			"-ar",
			"48000",
			"-ac",
			"1",
			noisePath,
		]);
		// Video with no audio stream at all.
		await generate([
			"-f",
			"lavfi",
			"-i",
			"color=black:s=64x64:d=0.5:r=10",
			"-c:v",
			"mpeg4",
			silentVideoPath,
		]);
	}, 120_000);

	afterAll(async () => {
		if (workDir) {
			await fs.rm(workDir, { recursive: true, force: true });
		}
	});

	it("reports stats for audio files and hasAudio:false for silent video", async () => {
		const audioStats = await measureAudioStats({ ffmpegPath, inputPath: hissPath });
		expect(audioStats.hasAudio).toBe(true);
		expect(audioStats.rmsLevelDb).toBeLessThan(-40);
		expect(audioStats.rmsTroughDb).not.toBeNull();

		const videoStats = await measureAudioStats({ ffmpegPath, inputPath: silentVideoPath });
		expect(videoStats.hasAudio).toBe(false);
	}, 60_000);

	it("hum preset measurably reduces quiet hiss (>= 10 dB)", async () => {
		const outputPath = path.join(workDir, "hiss-hum.wav");
		const before = await rmsOf(hissPath);
		const result = await denoiseAudioFile({
			ffmpegPath,
			inputPath: hissPath,
			outputPath,
			preset: "hum",
			strength: "high",
		});
		expect(result.measuredNoiseFloorDb).not.toBeNull();
		const after = await rmsOf(outputPath);
		expect(before - after).toBeGreaterThanOrEqual(10);
	}, 120_000);

	it("voice preset (arnndn) strongly reduces broadband noise (>= 15 dB)", async () => {
		const outputPath = path.join(workDir, "noise-voice.wav");
		const before = await rmsOf(noisePath);
		const result = await denoiseAudioFile({
			ffmpegPath,
			inputPath: noisePath,
			outputPath,
			preset: "voice",
			strength: "high",
			modelPathById: modelPaths,
		});
		expect(result.usedModel).toBe("sh");
		const after = await rmsOf(outputPath);
		expect(before - after).toBeGreaterThanOrEqual(15);
	}, 120_000);

	it("low strength removes less than high strength (mix blend is real)", async () => {
		const lowPath = path.join(workDir, "noise-low.wav");
		const highPath = path.join(workDir, "noise-high.wav");
		await denoiseAudioFile({
			ffmpegPath,
			inputPath: noisePath,
			outputPath: lowPath,
			preset: "voice",
			strength: "low",
			modelPathById: modelPaths,
		});
		await denoiseAudioFile({
			ffmpegPath,
			inputPath: noisePath,
			outputPath: highPath,
			preset: "voice",
			strength: "high",
			modelPathById: modelPaths,
		});
		const original = await rmsOf(noisePath);
		const low = await rmsOf(lowPath);
		const high = await rmsOf(highPath);
		expect(low).toBeLessThan(original);
		expect(high).toBeLessThan(low);
	}, 180_000);

	it("snippet mode processes only the requested window", async () => {
		const outputPath = path.join(workDir, "snippet.wav");
		await denoiseAudioFile({
			ffmpegPath,
			inputPath: noisePath,
			outputPath,
			preset: "voice",
			strength: "medium",
			modelPathById: modelPaths,
			snippet: { startSec: 1, durationSec: 1 },
		});
		const probe = await execFileAsync(
			ffmpegPath,
			["-hide_banner", "-i", outputPath, "-f", "null", "-"],
			{ timeout: 60_000 },
		);
		expect(probe.stderr).toMatch(/Duration: 00:00:01\.[0-9]/);
	}, 120_000);

	it("throws a clear error when denoising a file with no audio", async () => {
		await expect(
			denoiseAudioFile({
				ffmpegPath,
				inputPath: silentVideoPath,
				outputPath: path.join(workDir, "nope.wav"),
				preset: "voice",
				strength: "medium",
				modelPathById: modelPaths,
			}),
		).rejects.toThrow(/no audio track/);
	}, 60_000);
});
