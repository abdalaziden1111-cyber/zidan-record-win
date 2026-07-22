/**
 * Noise-cancellation presets mapped to ffmpeg filtergraphs.
 *
 * Pure module (no Electron imports) so the preset math is unit-testable.
 * Parameter choices are calibrated against the bundled ffmpeg 6.0 binary:
 * - afftdn only bites when `nf` sits at/above the actual noise floor, so
 *   afftdn presets accept a measured floor (astats RMS_trough) and clamp it
 *   into afftdn's accepted [-80, -20] range.
 * - afftdn's `tn` (track_noise) is deliberately NOT used: measured on real
 *   fixtures, the tracker adapts to steady noise and reduction collapses to
 *   ~2 dB, while an explicitly placed `nf` yields the full `nr` reduction.
 * - arnndn strength is expressed through `mix` (0..1 wet/dry blend).
 */

export type DenoisePresetId = "light" | "hum" | "voice" | "voice-music" | "max";
export type DenoiseStrength = "low" | "medium" | "high";
export type DenoiseModelId = "sh" | "bd";

export interface DenoisePresetInfo {
	id: DenoisePresetId;
	requiresModel: DenoiseModelId | null;
	defaultLabel: string;
}

export const DENOISE_PRESETS: DenoisePresetInfo[] = [
	{ id: "light", requiresModel: null, defaultLabel: "Light cleanup" },
	{ id: "hum", requiresModel: null, defaultLabel: "Office / fan hum" },
	{ id: "voice", requiresModel: "sh", defaultLabel: "Voice focus" },
	{ id: "voice-music", requiresModel: "bd", defaultLabel: "Voice + music" },
	{ id: "max", requiresModel: "sh", defaultLabel: "Maximum" },
];

export const DEFAULT_DENOISE_PRESET: DenoisePresetId = "voice";
export const DEFAULT_DENOISE_STRENGTH: DenoiseStrength = "medium";

const AFFTDN_NOISE_FLOOR_MIN = -80;
const AFFTDN_NOISE_FLOOR_MAX = -20;
const AFFTDN_NR_MIN = 0.01;
const AFFTDN_NR_MAX = 97;

/** How far above the measured noise floor afftdn's `nf` is placed. */
const MEASURED_FLOOR_HEADROOM_DB = 6;

const AFFTDN_NR_BY_STRENGTH: Record<"light" | "hum" | "max", Record<DenoiseStrength, number>> = {
	light: { low: 6, medium: 10, high: 14 },
	hum: { low: 12, medium: 18, high: 24 },
	max: { low: 8, medium: 10, high: 12 },
};

const AFFTDN_FALLBACK_NF: Record<"light" | "hum" | "max", number> = {
	light: -45,
	hum: -38,
	max: -45,
};

const ARNNDN_MIX_BY_STRENGTH: Record<
	"voice" | "voice-music" | "max",
	Record<DenoiseStrength, number>
> = {
	voice: { low: 0.55, medium: 0.8, high: 1 },
	"voice-music": { low: 0.55, medium: 0.8, high: 1 },
	max: { low: 0.7, medium: 0.9, high: 1 },
};

export function clampAfftdnNoiseFloorDb(value: number): number {
	if (!Number.isFinite(value)) {
		return AFFTDN_FALLBACK_NF.light;
	}
	return Math.min(AFFTDN_NOISE_FLOOR_MAX, Math.max(AFFTDN_NOISE_FLOOR_MIN, Math.round(value)));
}

/**
 * Derive afftdn's `nf` from a measured noise floor (astats RMS_trough).
 * afftdn attenuates content below `nf`, so we sit slightly above the
 * measured floor; without a usable measurement we use the preset fallback.
 */
export function deriveAfftdnNoiseFloorDb(
	measuredTroughDb: number | null | undefined,
	fallbackDb: number,
): number {
	if (measuredTroughDb == null || !Number.isFinite(measuredTroughDb) || measuredTroughDb >= 0) {
		return clampAfftdnNoiseFloorDb(fallbackDb);
	}
	return clampAfftdnNoiseFloorDb(measuredTroughDb + MEASURED_FLOOR_HEADROOM_DB);
}

function clampAfftdnNr(value: number): number {
	return Math.min(AFFTDN_NR_MAX, Math.max(AFFTDN_NR_MIN, value));
}

/**
 * Escape a file path for use inside an ffmpeg filtergraph option value.
 * Backslashes become forward slashes (ffmpeg accepts them on Windows too),
 * then the value is single-quoted with embedded quotes handled shell-style.
 */
export function escapeFilterPath(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	return `'${normalized.replace(/'/g, "'\\''")}'`;
}

export interface BuildDenoiseFilterChainOptions {
	preset: DenoisePresetId;
	strength: DenoiseStrength;
	/** astats RMS_trough of the input, in dB (negative), when available. */
	measuredNoiseFloorDb?: number | null;
	/** Absolute paths of available .rnnn model files. */
	modelPathById?: Partial<Record<DenoiseModelId, string>>;
}

export interface DenoiseFilterChain {
	filter: string;
	usedModel: DenoiseModelId | null;
}

function buildAfftdnFilter(
	presetKey: "light" | "hum" | "max",
	strength: DenoiseStrength,
	measuredNoiseFloorDb: number | null | undefined,
): string {
	const nr = clampAfftdnNr(AFFTDN_NR_BY_STRENGTH[presetKey][strength]);
	const nf = deriveAfftdnNoiseFloorDb(measuredNoiseFloorDb, AFFTDN_FALLBACK_NF[presetKey]);
	return `afftdn=nr=${nr}:nf=${nf}`;
}

function buildArnndnFilter(
	presetKey: "voice" | "voice-music" | "max",
	strength: DenoiseStrength,
	modelId: DenoiseModelId,
	modelPathById: Partial<Record<DenoiseModelId, string>> | undefined,
): string {
	const modelPath = modelPathById?.[modelId];
	if (!modelPath) {
		throw new Error(`The "${presetKey}" preset requires the "${modelId}" RNNoise model file.`);
	}
	const mix = ARNNDN_MIX_BY_STRENGTH[presetKey][strength];
	return `arnndn=m=${escapeFilterPath(modelPath)}:mix=${mix}`;
}

export function buildDenoiseFilterChain(
	options: BuildDenoiseFilterChainOptions,
): DenoiseFilterChain {
	const { preset, strength, measuredNoiseFloorDb, modelPathById } = options;

	switch (preset) {
		case "light":
			return {
				filter: buildAfftdnFilter("light", strength, measuredNoiseFloorDb),
				usedModel: null,
			};
		case "hum":
			return {
				filter: `highpass=f=60,${buildAfftdnFilter("hum", strength, measuredNoiseFloorDb)}`,
				usedModel: null,
			};
		case "voice":
			return {
				filter: buildArnndnFilter("voice", strength, "sh", modelPathById),
				usedModel: "sh",
			};
		case "voice-music":
			return {
				filter: buildArnndnFilter("voice-music", strength, "bd", modelPathById),
				usedModel: "bd",
			};
		case "max":
			return {
				filter: `${buildArnndnFilter("max", strength, "sh", modelPathById)},${buildAfftdnFilter("max", strength, measuredNoiseFloorDb)}`,
				usedModel: "sh",
			};
		default: {
			const exhaustive: never = preset;
			throw new Error(`Unknown denoise preset: ${String(exhaustive)}`);
		}
	}
}
