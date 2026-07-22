import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ipcMain } from "electron";
import { DENOISE_CACHE_DIR } from "../constants";
import { denoiseAudioFile, measureAudioStats } from "../denoise/engine";
import { resolveDenoiseModelPaths } from "../denoise/models";
import { DENOISE_PRESETS, type DenoisePresetId, type DenoiseStrength } from "../denoise/presets";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import { rememberApprovedLocalReadPath } from "../project/manager";

const PREVIEW_SNIPPET_DURATION_SEC = 6;

function isDenoisePresetId(value: unknown): value is DenoisePresetId {
	return DENOISE_PRESETS.some((preset) => preset.id === value);
}

function isDenoiseStrength(value: unknown): value is DenoiseStrength {
	return value === "low" || value === "medium" || value === "high";
}

async function buildCacheKey(
	inputPath: string,
	preset: DenoisePresetId,
	strength: DenoiseStrength,
): Promise<string> {
	const stat = await fs.stat(inputPath);
	return createHash("sha1")
		.update(`${inputPath}|${stat.size}|${stat.mtimeMs}|${preset}|${strength}`)
		.digest("hex")
		.slice(0, 16);
}

export function registerDenoiseHandlers() {
	ipcMain.handle("denoise-get-status", async () => {
		try {
			const modelPathById = await resolveDenoiseModelPaths();
			return {
				success: true,
				presets: DENOISE_PRESETS.map((preset) => ({
					id: preset.id,
					label: preset.defaultLabel,
					requiresModel: preset.requiresModel,
					available:
						preset.requiresModel == null ||
						Boolean(modelPathById[preset.requiresModel]),
				})),
			};
		} catch (error) {
			console.error("Failed to resolve denoise status:", error);
			return { success: false, presets: [], error: String(error) };
		}
	});

	ipcMain.handle(
		"denoise-audio",
		async (
			_event,
			options: { inputPath: string; preset: DenoisePresetId; strength: DenoiseStrength },
		) => {
			try {
				if (!options?.inputPath) {
					return { success: false, error: "Missing inputPath" };
				}
				if (!isDenoisePresetId(options.preset)) {
					return {
						success: false,
						error: `Unknown denoise preset: ${String(options.preset)}`,
					};
				}
				if (!isDenoiseStrength(options.strength)) {
					return {
						success: false,
						error: `Unknown denoise strength: ${String(options.strength)}`,
					};
				}

				const modelPathById = await resolveDenoiseModelPaths();
				const ffmpegPath = getFfmpegBinaryPath();
				const cacheKey = await buildCacheKey(
					options.inputPath,
					options.preset,
					options.strength,
				);
				const outputPath = path.join(
					DENOISE_CACHE_DIR,
					`${path.parse(options.inputPath).name}.${options.preset}.${options.strength}.${cacheKey}.wav`,
				);

				await fs.mkdir(DENOISE_CACHE_DIR, { recursive: true });
				const alreadyCached = await fs
					.access(outputPath)
					.then(() => true)
					.catch(() => false);

				if (alreadyCached) {
					await rememberApprovedLocalReadPath(outputPath);
					return { success: true, outputPath, cached: true };
				}

				const result = await denoiseAudioFile({
					ffmpegPath,
					inputPath: options.inputPath,
					outputPath,
					preset: options.preset,
					strength: options.strength,
					modelPathById,
				});

				await rememberApprovedLocalReadPath(outputPath);
				return {
					success: true,
					outputPath: result.outputPath,
					cached: false,
					usedModel: result.usedModel,
				};
			} catch (error) {
				console.error("Failed to denoise audio:", error);
				return { success: false, error: String(error) };
			}
		},
	);

	ipcMain.handle(
		"denoise-preview",
		async (
			_event,
			options: {
				inputPath: string;
				preset: DenoisePresetId;
				strength: DenoiseStrength;
				startSec?: number;
			},
		) => {
			try {
				if (!options?.inputPath) {
					return { success: false, error: "Missing inputPath" };
				}
				if (!isDenoisePresetId(options.preset)) {
					return {
						success: false,
						error: `Unknown denoise preset: ${String(options.preset)}`,
					};
				}
				if (!isDenoiseStrength(options.strength)) {
					return {
						success: false,
						error: `Unknown denoise strength: ${String(options.strength)}`,
					};
				}

				const modelPathById = await resolveDenoiseModelPaths();
				const ffmpegPath = getFfmpegBinaryPath();
				const snippet = {
					startSec: Math.max(0, options.startSec ?? 0),
					durationSec: PREVIEW_SNIPPET_DURATION_SEC,
				};

				const beforeStats = await measureAudioStats({
					ffmpegPath,
					inputPath: options.inputPath,
					snippet,
				});
				if (!beforeStats.hasAudio) {
					return { success: false, error: "No audio track to preview." };
				}

				const cacheKey = await buildCacheKey(
					options.inputPath,
					options.preset,
					options.strength,
				);
				await fs.mkdir(DENOISE_CACHE_DIR, { recursive: true });
				const outputPath = path.join(
					DENOISE_CACHE_DIR,
					`preview-${path.parse(options.inputPath).name}.${options.preset}.${options.strength}.${cacheKey}.wav`,
				);

				const result = await denoiseAudioFile({
					ffmpegPath,
					inputPath: options.inputPath,
					outputPath,
					preset: options.preset,
					strength: options.strength,
					measuredNoiseFloorDb: beforeStats.rmsTroughDb,
					modelPathById,
					snippet,
				});

				const afterStats = await measureAudioStats({
					ffmpegPath,
					inputPath: result.outputPath,
				});
				await rememberApprovedLocalReadPath(result.outputPath);

				return {
					success: true,
					outputPath: result.outputPath,
					beforeRmsDb: beforeStats.rmsLevelDb,
					afterRmsDb: afterStats.rmsLevelDb,
				};
			} catch (error) {
				console.error("Failed to preview denoise:", error);
				return { success: false, error: String(error) };
			}
		},
	);
}
