import { useCallback, useEffect, useMemo, useState } from "react";
import type {
	DenoisePresetId,
	DenoisePresetStatus,
	DenoiseStrength,
	DenoiseTrackState,
} from "./audioTypes";

const DEFAULT_PRESET: DenoisePresetId = "light";
const DEFAULT_STRENGTH: DenoiseStrength = "medium";

function createDefaultTrackState(): DenoiseTrackState {
	return {
		preset: DEFAULT_PRESET,
		strength: DEFAULT_STRENGTH,
		outputPath: null,
		busy: false,
		error: null,
	};
}

export function useSourceAudioDenoise() {
	const [presets, setPresets] = useState<DenoisePresetStatus[]>([]);
	const [trackStateByPath, setTrackStateByPath] = useState<Record<string, DenoiseTrackState>>({});

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const result = await window.electronAPI.getDenoiseStatus();
				if (!cancelled && result.success) {
					setPresets(result.presets);
				}
			} catch (error) {
				console.error("Failed to load denoise status:", error);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const getTrackState = useCallback(
		(originalPath: string): DenoiseTrackState =>
			trackStateByPath[originalPath] ?? createDefaultTrackState(),
		[trackStateByPath],
	);

	const setTrackOption = useCallback(
		(originalPath: string, patch: Partial<Pick<DenoiseTrackState, "preset" | "strength">>) => {
			setTrackStateByPath((prev) => ({
				...prev,
				[originalPath]: { ...(prev[originalPath] ?? createDefaultTrackState()), ...patch },
			}));
		},
		[],
	);

	const applyDenoise = useCallback(
		async (originalPath: string) => {
			const current = trackStateByPath[originalPath] ?? createDefaultTrackState();
			setTrackStateByPath((prev) => ({
				...prev,
				[originalPath]: { ...current, busy: true, error: null },
			}));
			try {
				const result = await window.electronAPI.denoiseAudio({
					inputPath: originalPath,
					preset: current.preset,
					strength: current.strength,
				});
				setTrackStateByPath((prev) => ({
					...prev,
					[originalPath]: {
						...(prev[originalPath] ?? current),
						busy: false,
						error: result.success ? null : (result.error ?? "Failed to reduce noise."),
						outputPath: result.success
							? (result.outputPath ?? null)
							: (prev[originalPath]?.outputPath ?? null),
					},
				}));
				return result;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				setTrackStateByPath((prev) => ({
					...prev,
					[originalPath]: {
						...(prev[originalPath] ?? current),
						busy: false,
						error: message,
					},
				}));
				return { success: false, error: message };
			}
		},
		[trackStateByPath],
	);

	const revertDenoise = useCallback((originalPath: string) => {
		setTrackStateByPath((prev) => ({
			...prev,
			[originalPath]: {
				...(prev[originalPath] ?? createDefaultTrackState()),
				outputPath: null,
				error: null,
			},
		}));
	}, []);

	const sourceAudioPathReplacements = useMemo(() => {
		const replacements: Record<string, string> = {};
		for (const [originalPath, state] of Object.entries(trackStateByPath)) {
			if (state.outputPath) {
				replacements[originalPath] = state.outputPath;
			}
		}
		return replacements;
	}, [trackStateByPath]);

	return {
		denoisePresets: presets,
		getDenoiseTrackState: getTrackState,
		setDenoiseTrackOption: setTrackOption,
		applyDenoise,
		revertDenoise,
		sourceAudioPathReplacements,
	};
}
