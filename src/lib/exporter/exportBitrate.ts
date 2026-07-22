import type { ExportEncodingMode, ExportMp4FrameRate, ExportQuality } from "./types";

const MIN_MP4_BITRATE = 2_000_000;

/**
 * Map absolute resolution tiers onto the relative tier whose bitrate
 * reference values fit that resolution class, so the floor/cap tables below
 * keep working for both flavors of ExportQuality.
 */
function qualityReferenceClass(quality: ExportQuality): "medium" | "good" | "high" | "source" {
	switch (quality) {
		case "720p":
			return "medium";
		case "1080p":
			return "good";
		case "2k":
			return "high";
		case "3k":
		case "4k":
			return "source";
		default:
			return quality;
	}
}
const REFERENCE_PIXEL_RATE = 1920 * 1080 * 30;
const REFERENCE_FRAME_RATE = 30;

export function getEncodingModeBitrateMultiplier(encodingMode: ExportEncodingMode): number {
	switch (encodingMode) {
		case "fast":
			return 0.1;
		case "quality":
			return 0.9;
		case "balanced":
		default:
			return 0.5;
	}
}

export function getSourceQualityBitrate(width: number, height: number): number {
	const totalPixels = width * height;
	if (totalPixels > 2560 * 1440) {
		return 80_000_000;
	}
	if (totalPixels > 1920 * 1080) {
		return 50_000_000;
	}
	return 30_000_000;
}

function getBaseMp4ExportBitrate(width: number, height: number, quality: ExportQuality): number {
	if (qualityReferenceClass(quality) === "source") {
		return getSourceQualityBitrate(width, height);
	}

	const totalPixels = width * height;
	if (totalPixels <= 1280 * 720) {
		return 10_000_000;
	}
	if (totalPixels <= 1920 * 1080) {
		return 20_000_000;
	}
	return 30_000_000;
}

function getFrameRateBitrateMultiplier(frameRate: ExportMp4FrameRate): number {
	// This only scales requestedBitrate above REFERENCE_FRAME_RATE, so 24fps
	// and 30fps share the same multiplier. useModernNativeStaticLayout can
	// still change the final bitrate because pixelRateScale uses frameRate
	// against REFERENCE_PIXEL_RATE for the native layout floor/cap.
	return Math.sqrt(Math.max(1, frameRate / REFERENCE_FRAME_RATE));
}

function getModernNativeStaticLayoutBitrateCap(
	width: number,
	height: number,
	frameRate: ExportMp4FrameRate,
	quality: ExportQuality,
): number {
	const qualityClass = qualityReferenceClass(quality);
	const referenceCap =
		qualityClass === "source"
			? 36_000_000
			: qualityClass === "high"
				? 28_000_000
				: qualityClass === "good"
					? 20_000_000
					: 14_000_000;
	const pixelRateScale = Math.max((width * height * frameRate) / REFERENCE_PIXEL_RATE, 0.1);
	return Math.round(referenceCap * Math.sqrt(pixelRateScale));
}

function getModernNativeStaticLayoutBitrateFloor(
	width: number,
	height: number,
	frameRate: ExportMp4FrameRate,
	quality: ExportQuality,
): number {
	const qualityClass = qualityReferenceClass(quality);
	const referenceFloor =
		qualityClass === "source"
			? 22_000_000
			: qualityClass === "high"
				? 16_000_000
				: qualityClass === "good"
					? 12_000_000
					: 8_000_000;
	const pixelRateScale = Math.max((width * height * frameRate) / REFERENCE_PIXEL_RATE, 0.1);
	return Math.round(referenceFloor * Math.sqrt(pixelRateScale));
}

export function getMp4ExportBitrate(options: {
	width: number;
	height: number;
	frameRate: ExportMp4FrameRate;
	quality: ExportQuality;
	encodingMode: ExportEncodingMode;
	useModernNativeStaticLayout?: boolean;
}): number {
	const requestedBitrate = Math.round(
		getBaseMp4ExportBitrate(options.width, options.height, options.quality) *
			getFrameRateBitrateMultiplier(options.frameRate) *
			getEncodingModeBitrateMultiplier(options.encodingMode),
	);
	const nativeStaticLayoutBitrate =
		options.useModernNativeStaticLayout && options.encodingMode !== "fast"
			? Math.max(
					requestedBitrate,
					getModernNativeStaticLayoutBitrateFloor(
						options.width,
						options.height,
						options.frameRate,
						options.quality,
					),
				)
			: requestedBitrate;
	const cappedBitrate = options.useModernNativeStaticLayout
		? Math.min(
				nativeStaticLayoutBitrate,
				getModernNativeStaticLayoutBitrateCap(
					options.width,
					options.height,
					options.frameRate,
					options.quality,
				),
			)
		: requestedBitrate;

	return Math.max(MIN_MP4_BITRATE, cappedBitrate);
}
