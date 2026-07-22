import type { AudioPeaksData } from "../timeline/core/timelineTypes";

export type SourceAudioTrackId = "mixed" | "system" | "mic" | (string & {});

export interface SourceAudioTrackSetting {
	volume: number;
	normalize: boolean;
}

export type SourceAudioTrackSettings = Record<string, SourceAudioTrackSetting>;

export interface SourceAudioTrackMetaItem {
	id: SourceAudioTrackId;
	label: string;
}

export type SourceAudioTrackMeta = SourceAudioTrackMetaItem[];

export interface SourceAudioTrackWithPeaks extends SourceAudioTrackMetaItem {
	peaks: AudioPeaksData;
}

export const SOURCE_AUDIO_FALLBACK_TOAST_ID = "source-audio-fallback-error";
export const SOURCE_AUDIO_NORMALIZE_GAIN = 1.35;

export type DenoisePresetId = "light" | "hum" | "voice" | "voice-music" | "max";
export type DenoiseStrength = "low" | "medium" | "high";

export interface DenoisePresetStatus {
	id: DenoisePresetId;
	label: string;
	requiresModel: "sh" | "bd" | null;
	available: boolean;
}

export interface DenoiseTrackState {
	preset: DenoisePresetId;
	strength: DenoiseStrength;
	outputPath: string | null;
	busy: boolean;
	error: string | null;
}
