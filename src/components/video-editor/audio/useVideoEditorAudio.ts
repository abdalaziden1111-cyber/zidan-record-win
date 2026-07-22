import React, { useCallback, useMemo } from "react";
import type { SourceAudioTrackSettings } from "@/components/video-editor/audio/audioTypes";
import { getSourceTrackIdFromPath, type SourceTrackId } from "@/lib/exporter/audioRoutingEngine";
import { resolveSourceTrackRoutingPolicy } from "@/lib/exporter/sourceTrackRoutingPolicy";
import type { AudioRegion, ClipRegion, SpeedRegion } from "../types";
import { getActiveClipIdAtSourceTime, isClipMutedById } from "./clipAudio";
import { useAudioPreviewSync } from "./useAudioPreviewSync";
import { useClipAudioSettingsController } from "./useClipAudioSettingsController";
import { useSourceAudioDenoise } from "./useSourceAudioDenoise";
import { useSourceAudioFallback } from "./useSourceAudioFallback";

function extractLocalPathFromMediaServerUrl(input: string | null | undefined): string | null {
	if (!input) return null;
	try {
		const url = new URL(input);
		const isLocalMediaServer =
			(url.protocol === "http:" || url.protocol === "https:") &&
			(url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
			url.pathname === "/video";
		if (!isLocalMediaServer) return null;
		return url.searchParams.get("path");
	} catch {
		return null;
	}
}

interface UseVideoEditorAudioParams {
	currentSourcePath: string | null;
	selectedClipId: string | null;
	clipRegions: ClipRegion[];
	audioRegions: AudioRegion[];
	effectiveSpeedRegions: SpeedRegion[];
	sourceAudioTrackSettingsByClip: Record<string, SourceAudioTrackSettings>;
	setSourceAudioTrackSettingsByClip: React.Dispatch<
		React.SetStateAction<Record<string, SourceAudioTrackSettings>>
	>;
	defaultSourceAudioTrackSettings: SourceAudioTrackSettings;
	setDefaultSourceAudioTrackSettings: React.Dispatch<
		React.SetStateAction<SourceAudioTrackSettings>
	>;
	currentTime: number;
	timelineTime: number;
	duration: number;
	isPlaying: boolean;
	previewVolume: number;
	sourceAudioFallbackRefreshKey?: number;
	/**
	 * Substitute processed audio for original sources (e.g. noise-cancelled
	 * files): keys are original fallback paths, values their replacements.
	 */
	sourceAudioPathReplacements?: Record<string, string>;
	/** Extra audio paths appended to the fallback list (e.g. a denoised copy of the embedded track). */
	additionalSourceAudioPaths?: string[];
	summarizeErrorMessage: (message: string) => string;
	onSourceFallbackLoadError: (error: unknown) => void;
}

export function useVideoEditorAudio({
	currentSourcePath,
	selectedClipId,
	clipRegions,
	audioRegions,
	effectiveSpeedRegions,
	sourceAudioTrackSettingsByClip,
	setSourceAudioTrackSettingsByClip,
	defaultSourceAudioTrackSettings,
	setDefaultSourceAudioTrackSettings,
	currentTime,
	timelineTime,
	duration,
	isPlaying,
	previewVolume,
	sourceAudioFallbackRefreshKey = 0,
	sourceAudioPathReplacements,
	additionalSourceAudioPaths,
	summarizeErrorMessage,
	onSourceFallbackLoadError,
}: UseVideoEditorAudioParams) {
	const fallbackLookupSourcePath = useMemo(
		() => extractLocalPathFromMediaServerUrl(currentSourcePath) ?? currentSourcePath,
		[currentSourcePath],
	);

	const {
		sourceAudioFallbackPaths: fetchedSourceAudioFallbackPaths,
		sourceAudioFallbackStartDelayMsByPath: fetchedStartDelayMsByPath,
	} = useSourceAudioFallback({
		currentSourcePath: fallbackLookupSourcePath,
		refreshKey: sourceAudioFallbackRefreshKey,
		summarizeErrorMessage,
	});

	const {
		denoisePresets,
		getDenoiseTrackState,
		setDenoiseTrackOption,
		applyDenoise,
		revertDenoise,
		sourceAudioPathReplacements: denoiseTrackReplacements,
	} = useSourceAudioDenoise();

	// Apply processed-audio substitutions so playback and export both see the
	// effective paths. Two sources of replacements are merged: the caller's
	// (global noise-cancellation switch) and the per-track denoise machinery —
	// the per-track choice wins for the same path. Start delays follow the
	// replaced paths; extra appended paths (e.g. a denoised copy of the
	// embedded track) join the end of the list.
	const { sourceAudioFallbackPaths, sourceAudioFallbackStartDelayMsByPath } = useMemo(() => {
		const replacements = {
			...(sourceAudioPathReplacements ?? {}),
			...denoiseTrackReplacements,
		};
		const additional = additionalSourceAudioPaths ?? [];
		const paths = fetchedSourceAudioFallbackPaths.map(
			(audioPath) => replacements[audioPath] ?? audioPath,
		);
		const delays: Record<string, number> = {};
		for (const [audioPath, delayMs] of Object.entries(fetchedStartDelayMsByPath)) {
			delays[replacements[audioPath] ?? audioPath] = delayMs;
		}
		for (const audioPath of additional) {
			if (!paths.includes(audioPath)) {
				paths.push(audioPath);
			}
		}
		return {
			sourceAudioFallbackPaths: paths,
			sourceAudioFallbackStartDelayMsByPath: delays,
		};
	}, [
		fetchedSourceAudioFallbackPaths,
		fetchedStartDelayMsByPath,
		sourceAudioPathReplacements,
		denoiseTrackReplacements,
		additionalSourceAudioPaths,
	]);

	// Maps "mic" / "system" / "mixed" back to the original (pre-denoise) sidecar
	// path, so the mixer UI can drive denoise per track without handling paths itself.
	const originalPathBySourceTrackId = useMemo(() => {
		const byTrackId: Partial<Record<SourceTrackId, string>> = {};
		for (const path of fetchedSourceAudioFallbackPaths) {
			const trackId = getSourceTrackIdFromPath(path);
			if (!byTrackId[trackId]) {
				byTrackId[trackId] = path;
			}
		}
		return byTrackId;
	}, [fetchedSourceAudioFallbackPaths]);

	const getDenoiseStateForTrack = useCallback(
		(trackId: string) => {
			const originalPath = originalPathBySourceTrackId[trackId as SourceTrackId];
			return originalPath ? getDenoiseTrackState(originalPath) : null;
		},
		[originalPathBySourceTrackId, getDenoiseTrackState],
	);

	const setDenoiseOptionForTrack = useCallback(
		(trackId: string, patch: { preset?: string; strength?: string }) => {
			const originalPath = originalPathBySourceTrackId[trackId as SourceTrackId];
			if (originalPath) {
				setDenoiseTrackOption(
					originalPath,
					patch as Parameters<typeof setDenoiseTrackOption>[1],
				);
			}
		},
		[originalPathBySourceTrackId, setDenoiseTrackOption],
	);

	const applyDenoiseForTrack = useCallback(
		(trackId: string) => {
			const originalPath = originalPathBySourceTrackId[trackId as SourceTrackId];
			return originalPath
				? applyDenoise(originalPath)
				: Promise.resolve({ success: false, error: "No audio source for this track." });
		},
		[originalPathBySourceTrackId, applyDenoise],
	);

	const revertDenoiseForTrack = useCallback(
		(trackId: string) => {
			const originalPath = originalPathBySourceTrackId[trackId as SourceTrackId];
			if (originalPath) revertDenoise(originalPath);
		},
		[originalPathBySourceTrackId, revertDenoise],
	);

	const sourceTrackRoutingPolicy = useMemo(
		() => resolveSourceTrackRoutingPolicy(currentSourcePath, sourceAudioFallbackPaths),
		[currentSourcePath, sourceAudioFallbackPaths],
	);
	const previewSourceAudioFallbackPaths = sourceTrackRoutingPolicy.playbackPaths;
	const shouldMutePreviewVideo = sourceTrackRoutingPolicy.muteEmbeddedPreview;

	const activeClipIdAtCurrentTime = useMemo(
		() => getActiveClipIdAtSourceTime(currentTime, clipRegions),
		[clipRegions, currentTime],
	);
	const isCurrentClipMuted = useMemo(
		() => isClipMutedById(activeClipIdAtCurrentTime, clipRegions),
		[activeClipIdAtCurrentTime, clipRegions],
	);

	const {
		sourceAudioTrackMeta,
		activeSourceAudioTrackSettings,
		selectedClipSourceAudioTrackSettings,
		getSourceAudioTrackSettingsForClip,
		onSourceAudioTracksMetaChange,
		onSelectedClipSourceAudioTrackVolumeChange,
		onSelectedClipSourceAudioTrackNormalizeChange,
		onDefaultSourceAudioTrackVolumeChange,
		onDefaultSourceAudioTrackNormalizeChange,
		embeddedSourcePreviewGain,
		getSourceTrackPreviewGain,
	} = useClipAudioSettingsController({
		selectedClipId,
		activeClipId: activeClipIdAtCurrentTime,
		sourceAudioTrackSettingsByClip,
		setSourceAudioTrackSettingsByClip,
		defaultSourceAudioTrackSettings,
		setDefaultSourceAudioTrackSettings,
	});

	const { playSourceAudioPreview } = useAudioPreviewSync({
		audioRegions,
		previewVolume,
		isPlaying,
		currentTime,
		timelineTime,
		duration,
		effectiveSpeedRegions,
		previewSourceAudioFallbackPaths,
		sourceAudioFallbackStartDelayMsByPath,
		isCurrentClipMuted,
		getSourceTrackPreviewGain,
		onSourceFallbackLoadError,
	});

	return {
		sourceAudioFallbackPaths,
		sourceAudioFallbackStartDelayMsByPath,
		previewSourceAudioFallbackPaths,
		shouldMutePreviewVideo,
		activeClipIdAtCurrentTime,
		isCurrentClipMuted,
		sourceAudioTrackMeta,
		activeSourceAudioTrackSettings,
		selectedClipSourceAudioTrackSettings,
		playSourceAudioPreview,
		getSourceAudioTrackSettingsForClip,
		onSourceAudioTracksMetaChange,
		onSelectedClipSourceAudioTrackVolumeChange,
		onSelectedClipSourceAudioTrackNormalizeChange,
		onDefaultSourceAudioTrackVolumeChange,
		onDefaultSourceAudioTrackNormalizeChange,
		embeddedSourcePreviewGain,
		getSourceTrackPreviewGain,
		denoisePresets,
		getDenoiseStateForTrack,
		setDenoiseOptionForTrack,
		applyDenoiseForTrack,
		revertDenoiseForTrack,
	};
}
