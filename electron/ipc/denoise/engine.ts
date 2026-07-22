import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	buildDenoiseFilterChain,
	type DenoiseFilterChain,
	type DenoiseModelId,
	type DenoisePresetId,
	type DenoiseStrength,
} from "./presets";

const execFileAsync = promisify(execFile);

const MEASURE_TIMEOUT_MS = 2 * 60 * 1000;
const PROCESS_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BUFFER = 20 * 1024 * 1024;

export interface AudioStats {
	hasAudio: boolean;
	rmsLevelDb: number | null;
	rmsTroughDb: number | null;
}

function parseStatDb(stderr: string, label: string): number | null {
	const match = stderr.match(new RegExp(`${label}\\s*dB:\\s*(-?[\\d.]+|-inf)`, "i"));
	if (!match) {
		return null;
	}
	if (match[1] === "-inf") {
		return null;
	}
	const value = Number.parseFloat(match[1]);
	return Number.isFinite(value) ? value : null;
}

function isMissingAudioStreamError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /matches no streams|does not contain any stream|Output file does not contain any stream/i.test(
		message,
	);
}

/**
 * Measure overall RMS level and RMS trough (a practical noise-floor proxy:
 * the quietest analysis frame, i.e. pauses between speech) of the first
 * audio stream. Returns hasAudio:false instead of throwing when the input
 * has no audio track.
 */
export async function measureAudioStats(options: {
	ffmpegPath: string;
	inputPath: string;
	/** Measure only a window of the input (matches a preview snippet). */
	snippet?: { startSec: number; durationSec: number };
}): Promise<AudioStats> {
	try {
		const result = await execFileAsync(
			options.ffmpegPath,
			[
				"-hide_banner",
				...(options.snippet ? ["-ss", String(options.snippet.startSec)] : []),
				...(options.snippet ? ["-t", String(options.snippet.durationSec)] : []),
				"-i",
				options.inputPath,
				"-map",
				"0:a:0",
				"-af",
				"astats=measure_overall=RMS_level+RMS_trough:measure_perchannel=none",
				"-f",
				"null",
				"-",
			],
			{ timeout: MEASURE_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
		);

		const stderr = result.stderr ?? "";
		return {
			hasAudio: true,
			rmsLevelDb: parseStatDb(stderr, "RMS level"),
			rmsTroughDb: parseStatDb(stderr, "RMS trough"),
		};
	} catch (error) {
		if (isMissingAudioStreamError(error)) {
			return { hasAudio: false, rmsLevelDb: null, rmsTroughDb: null };
		}
		throw error;
	}
}

export interface DenoiseAudioFileOptions {
	ffmpegPath: string;
	inputPath: string;
	/** Output path; written as 16-bit PCM WAV. */
	outputPath: string;
	preset: DenoisePresetId;
	strength: DenoiseStrength;
	modelPathById?: Partial<Record<DenoiseModelId, string>>;
	/** Process only a snippet (fast A/B preview). */
	snippet?: { startSec: number; durationSec: number };
	/**
	 * Measured input noise floor (astats RMS_trough). When omitted for an
	 * afftdn-based preset, the engine measures it itself.
	 */
	measuredNoiseFloorDb?: number | null;
}

export interface DenoiseAudioFileResult extends DenoiseFilterChain {
	outputPath: string;
	measuredNoiseFloorDb: number | null;
}

const PRESETS_NEEDING_FLOOR: ReadonlySet<DenoisePresetId> = new Set(["light", "hum", "max"]);

/**
 * Denoise the first audio stream of a media file into a new WAV file.
 * The input is never modified. Throws if the input has no audio stream.
 */
export async function denoiseAudioFile(
	options: DenoiseAudioFileOptions,
): Promise<DenoiseAudioFileResult> {
	let measuredNoiseFloorDb = options.measuredNoiseFloorDb ?? null;

	if (measuredNoiseFloorDb == null && PRESETS_NEEDING_FLOOR.has(options.preset)) {
		const stats = await measureAudioStats({
			ffmpegPath: options.ffmpegPath,
			inputPath: options.inputPath,
		});
		if (!stats.hasAudio) {
			throw new Error("The selected file has no audio track to denoise.");
		}
		measuredNoiseFloorDb = stats.rmsTroughDb;
	}

	const chain = buildDenoiseFilterChain({
		preset: options.preset,
		strength: options.strength,
		measuredNoiseFloorDb,
		modelPathById: options.modelPathById,
	});

	const args: string[] = ["-hide_banner", "-y"];
	if (options.snippet) {
		args.push(
			"-ss",
			String(Math.max(0, options.snippet.startSec)),
			"-t",
			String(Math.max(0.1, options.snippet.durationSec)),
		);
	}
	args.push(
		"-i",
		options.inputPath,
		"-vn",
		"-map",
		"0:a:0",
		"-af",
		chain.filter,
		"-c:a",
		"pcm_s16le",
		options.outputPath,
	);

	try {
		await execFileAsync(options.ffmpegPath, args, {
			timeout: PROCESS_TIMEOUT_MS,
			maxBuffer: MAX_BUFFER,
		});
	} catch (error) {
		if (isMissingAudioStreamError(error)) {
			throw new Error("The selected file has no audio track to denoise.");
		}
		throw error;
	}

	return { ...chain, outputPath: options.outputPath, measuredNoiseFloorDb };
}
