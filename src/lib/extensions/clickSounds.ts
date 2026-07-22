/**
 * Click sounds registered declaratively by extensions (registerClickSound).
 *
 * Pure helpers shared between the preview host (auto-play on cursor:click)
 * and the export pipeline (scheduling samples into the offline audio mix) so
 * both react to the same interaction types with the same gains.
 */

export const DEFAULT_CLICK_SOUND_INTERACTION_TYPES = [
	"click",
	"double-click",
	"right-click",
	"middle-click",
] as const;

export interface RegisteredClickSound {
	/** Resolved URL of the sound file (extension-relative path resolved by the host). */
	url: string;
	/** Extension-declared volume, 0-1. */
	volume: number;
	/** Interaction types this sound reacts to. */
	interactionTypes: string[];
}

export interface ClickSoundExportEvent {
	/** Click timestamp in SOURCE time (cursor telemetry coordinates). */
	sourceTimeMs: number;
	/** Resolved URL of the sound file to mix in. */
	audioPath: string;
	/** Final gain: extension volume × editor click-sound mixer volume, clamped 0-1. */
	gain: number;
}

/**
 * Cross registered click sounds with cursor telemetry to produce the events
 * the export audio mixer schedules. Gains mirror preview playback:
 * clamp01(extensionVolume × clickSoundVolume). Events land in source time;
 * the exporter maps them through trims/speeds and drops clicks inside cut
 * footage.
 */
export function buildClickSoundExportEvents(params: {
	telemetry: Array<{ timeMs: number; interactionType?: string }>;
	clickSounds: RegisteredClickSound[];
	clickSoundVolume: number;
}): ClickSoundExportEvent[] {
	const { telemetry, clickSounds, clickSoundVolume } = params;
	if (clickSounds.length === 0 || telemetry.length === 0) {
		return [];
	}

	const events: ClickSoundExportEvent[] = [];
	for (const point of telemetry) {
		const interactionType = point.interactionType;
		if (!interactionType || interactionType === "move") continue;
		if (!Number.isFinite(point.timeMs) || point.timeMs < 0) continue;

		for (const sound of clickSounds) {
			if (!sound.interactionTypes.includes(interactionType)) continue;
			const gain = Math.max(0, Math.min(1, sound.volume * clickSoundVolume));
			if (gain <= 0.0005) continue;
			events.push({
				sourceTimeMs: Math.round(point.timeMs),
				audioPath: sound.url,
				gain,
			});
		}
	}

	return events.sort((a, b) => a.sourceTimeMs - b.sourceTimeMs);
}
