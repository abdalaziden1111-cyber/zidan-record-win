import { fixWebmDuration } from "@fix-webm-duration/fix";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getEffectiveRecordingDurationMs } from "@/lib/mediaTiming";
import {
	getVideoExtensionForMimeType,
	isWebmMimeType,
	selectRecordingMimeType,
	selectWebcamRecordingMimeType,
} from "./recordingMimeType";

const TARGET_FRAME_RATE = 60;
const TARGET_WIDTH = 3840;
const TARGET_HEIGHT = 2160;

const QUALITY_DIMENSIONS: Record<string, { width: number; height: number }> = {
	"720p": { width: 1280, height: 720 },
	"1080p": { width: 1920, height: 1080 },
	"2k": { width: 2560, height: 1440 },
	"3k": { width: 2880, height: 1620 },
	"4k": { width: 3840, height: 2160 },
};
const FOUR_K_PIXELS = TARGET_WIDTH * TARGET_HEIGHT;
const QHD_WIDTH = 2560;
const QHD_HEIGHT = 1440;
const QHD_PIXELS = QHD_WIDTH * QHD_HEIGHT;
const BITRATE_4K = 45_000_000;
const BITRATE_QHD = 28_000_000;
const BITRATE_BASE = 18_000_000;
const HIGH_FRAME_RATE_THRESHOLD = 60;
const HIGH_FRAME_RATE_BOOST = 1.7;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const CODEC_ALIGNMENT = 2;
const RECORDER_TIMESLICE_MS = 250;
const BITS_PER_MEGABIT = 1_000_000;
const MIN_FRAME_RATE = 30;
const CHROME_MEDIA_SOURCE = "desktop";
const RECORDING_FILE_PREFIX = "recording-";
const AUDIO_BITRATE_VOICE = 128_000;
const AUDIO_BITRATE_SYSTEM = 192_000;
const MIC_GAIN_BOOST = 1.4;
const WEBCAM_BITRATE = 8_000_000;
// Request the highest resolution the camera supports; browsers resolve
// "ideal" to the closest capability, so a 1080p webcam still yields 1080p.
const WEBCAM_WIDTH = 3840;
const WEBCAM_HEIGHT = 2160;
// The secondary camera is capped at 1080p to keep two simultaneous
// capture+encode pipelines affordable.
const SECONDARY_WEBCAM_WIDTH = 1920;
const SECONDARY_WEBCAM_HEIGHT = 1080;
const WEBCAM_FRAME_RATE = 30;
const WEBCAM_SUFFIXES = ["-webcam", "-webcam2"];
const MAX_WEBCAM_DEVICES = WEBCAM_SUFFIXES.length;
const SECONDARY_WEBCAM_ERROR_TOAST_ID = "recording-secondary-webcam-error";
const MICROPHONE_FALLBACK_ERROR_TOAST_ID = "recording-microphone-fallback-error";
const MICROPHONE_SIDECAR_ERROR_TOAST_ID = "recording-microphone-sidecar-error";
const RECORDING_START_TIMEOUT_MS = 30_000;
const NATIVE_CAPTURE_TIMEOUT_MS = 15_000;
const CONSTRAINTS_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`${label} timed out after ${ms}ms`));
		}, ms);
		promise.then(
			(value) => { clearTimeout(timer); resolve(value); },
			(error) => { clearTimeout(timer); reject(error); },
		);
	});
}
export type BrowserMicrophoneProfile =
	| "processed"
	| "no-agc"
	| "no-echo"
	| "no-noise-suppression"
	| "raw";
type BrowserCaptureCursorMode = "always" | "never";
export type BrowserCaptureCursorPolicy = {
	streamCursor: BrowserCaptureCursorMode;
	hideOsCursorBeforeRecording: boolean;
	hideEditorOverlayCursorByDefault: boolean;
};
const DEFAULT_BROWSER_MICROPHONE_PROFILE: BrowserMicrophoneProfile = "processed";
const BROWSER_MICROPHONE_PROFILES = new Set<BrowserMicrophoneProfile>([
	"processed",
	"no-agc",
	"no-echo",
	"no-noise-suppression",
	"raw",
]);
type MicrophoneTrackSettingsSnapshot = Partial<
	Pick<
		MediaTrackSettings,
		| "autoGainControl"
		| "channelCount"
		| "deviceId"
		| "echoCancellation"
		| "groupId"
		| "noiseSuppression"
		| "sampleRate"
		| "sampleSize"
	>
> & {
	trackId?: string;
	trackLabel?: string;
	trackEnabled?: boolean;
	trackMuted?: boolean;
	trackReadyState?: MediaStreamTrackState;
};
type MicrophoneAudioInputDeviceSnapshot = {
	deviceId: string;
	groupId?: string;
	label: string;
};
type MicrophoneFallbackChunkEvent = {
	index: number;
	size: number;
	elapsedMs: number;
	deltaMs: number | null;
	recordedElapsedMs: number;
	recordedDeltaMs: number | null;
};
type MicrophoneFallbackPauseInterval = {
	startElapsedMs: number;
	endElapsedMs?: number;
	durationMs?: number;
};
type MicrophoneFallbackRecorderMetadata = {
	mimeType: string;
	audioBitsPerSecond: number;
	timesliceMs: number;
};
type MicrophoneSidecarOptions = {
	startDelayMs?: number;
	browserMicrophoneProfile?: BrowserMicrophoneProfile;
	requestedBrowserMicrophoneProfile?: string | null;
	requestedConstraints?: MediaStreamConstraints;
	mediaTrackSettings?: MicrophoneTrackSettingsSnapshot;
	audioInputDevices?: MicrophoneAudioInputDeviceSnapshot[];
	mediaRecorder?: MicrophoneFallbackRecorderMetadata;
	chunkEvents?: MicrophoneFallbackChunkEvent[];
	pauseIntervals?: MicrophoneFallbackPauseInterval[];
};
const LINUX_PORTAL_SOURCE: ProcessedDesktopSource = {
	id: "screen:linux-portal",
	name: "Linux Portal",
	display_id: "",
	thumbnail: null,
	appIcon: null,
	sourceType: "screen",
};

type DesktopCaptureMediaDevices = {
	getUserMedia: (constraints: unknown) => Promise<MediaStream>;
	getDisplayMedia: (constraints: unknown) => Promise<MediaStream>;
};

export type RecordingQuality = "720p" | "1080p" | "2k" | "3k" | "4k";

type UseScreenRecorderReturn = {
	recording: boolean;
	paused: boolean;
	finalizing: boolean;
	countdownActive: boolean;
	toggleRecording: () => void;
	pauseRecording: () => void;
	resumeRecording: () => void;
	cancelRecording: () => void;
	preparePermissions: (options?: { startup?: boolean }) => Promise<boolean>;
	isMacOS: boolean;
	microphoneEnabled: boolean;
	setMicrophoneEnabled: (enabled: boolean) => void;
	microphoneDeviceId: string | undefined;
	setMicrophoneDeviceId: (deviceId: string | undefined) => void;
	systemAudioEnabled: boolean;
	setSystemAudioEnabled: (enabled: boolean) => void;
	webcamEnabled: boolean;
	setWebcamEnabled: (enabled: boolean) => void;
	webcamDeviceId: string | undefined;
	setWebcamDeviceId: (deviceId: string | undefined) => void;
	webcamDeviceIds: string[];
	setWebcamDeviceIds: (deviceIds: string[]) => void;
	countdownDelay: number;
	setCountdownDelay: (delay: number) => void;
	recordingQuality: RecordingQuality;
	setRecordingQuality: (quality: RecordingQuality) => void;
};

export type WebcamTrackResult = {
	path: string;
	timeOffsetMs: number;
	deviceLabel?: string;
};

type WebcamCaptureSlot = {
	deviceId: string | undefined;
	label: string | null;
	stream: MediaStream | null;
	recorder: MediaRecorder | null;
	chunks: Blob[];
	startTime: number | null;
	timeOffsetMs: number;
	resolvedPath: string | null;
	stopPromise: Promise<string | null> | null;
	stopResolver: ((path: string | null) => void) | null;
};

function getErrorMessage(error: unknown) {
	if (error instanceof Error && error.message) {
		return error.message;
	}

	if (typeof error === "string" && error.trim().length > 0) {
		return error;
	}

	if (typeof error === "object" && error !== null) {
		try {
			const serialized = JSON.stringify(error);
			if (serialized && serialized !== "{}") {
				return serialized;
			}
		} catch {
			// Ignore stringify failures and fall through to a generic message.
		}

		if (typeof (error as { toString?: () => string }).toString === "function") {
			const stringified = (error as { toString: () => string }).toString();
			if (stringified && stringified !== "[object Object]") {
				return stringified;
			}
		}
	}

	return "An unexpected error occurred";
}

export function normalizeBrowserMicrophoneProfile(value?: string | null): BrowserMicrophoneProfile {
	const normalized = value?.trim().toLowerCase();
	return normalized && BROWSER_MICROPHONE_PROFILES.has(normalized as BrowserMicrophoneProfile)
		? (normalized as BrowserMicrophoneProfile)
		: DEFAULT_BROWSER_MICROPHONE_PROFILE;
}

export function resolveBrowserCaptureCursorPolicy({
	nativeWindowsCaptureStartFailed = false,
}: {
	nativeWindowsCaptureStartFailed?: boolean;
} = {}): BrowserCaptureCursorPolicy {
	if (nativeWindowsCaptureStartFailed) {
		// If WGC already failed, avoid the telemetry overlay path that can lag on
		// constrained Windows systems; keep the browser-captured cursor instead.
		return {
			streamCursor: "always",
			hideOsCursorBeforeRecording: false,
			hideEditorOverlayCursorByDefault: true,
		};
	}

	return {
		streamCursor: "never",
		hideOsCursorBeforeRecording: true,
		hideEditorOverlayCursorByDefault: true,
	};
}

export function shouldUseNativeWindowsCaptureForSource(
	source: Pick<ProcessedDesktopSource, "id"> | null | undefined,
): boolean {
	return (
		source?.id?.startsWith("screen:") === true ||
		source?.id?.startsWith("window:") === true
	);
}

export function createProcessedMicrophoneConstraints(
	microphoneDeviceId?: string,
	profile: BrowserMicrophoneProfile = DEFAULT_BROWSER_MICROPHONE_PROFILE,
): MediaStreamConstraints {
	const normalizedProfile = normalizeBrowserMicrophoneProfile(profile);
	const audio: MediaTrackConstraints = {
		echoCancellation: normalizedProfile !== "no-echo" && normalizedProfile !== "raw",
		noiseSuppression:
			normalizedProfile !== "no-noise-suppression" && normalizedProfile !== "raw",
		autoGainControl: normalizedProfile !== "no-agc" && normalizedProfile !== "raw",
		channelCount: { ideal: 1 },
		sampleRate: { ideal: 48000 },
	};

	if (microphoneDeviceId) {
		audio.deviceId = { exact: microphoneDeviceId };
	}

	return { audio, video: false };
}

export function createBrowserRecordingOptions({
	audioBitsPerSecond,
	mimeType,
	videoBitsPerSecond,
}: {
	audioBitsPerSecond?: number;
	mimeType?: string;
	videoBitsPerSecond: number;
}): MediaRecorderOptions {
	const options: MediaRecorderOptions = {
		videoBitsPerSecond,
		bitsPerSecond: videoBitsPerSecond + (audioBitsPerSecond ?? 0),
	};

	if (audioBitsPerSecond !== undefined) {
		options.audioBitsPerSecond = audioBitsPerSecond;
	}

	if (mimeType) {
		options.mimeType = mimeType;
	}

	return options;
}

function createMicrophoneTrackSettingsSnapshot(
	stream: MediaStream,
): MicrophoneTrackSettingsSnapshot | null {
	const track = stream.getAudioTracks()[0];
	const settings = track?.getSettings?.();
	if (!track || !settings) {
		return null;
	}

	const snapshot: MicrophoneTrackSettingsSnapshot = {
		trackId: track.id,
		trackLabel: track.label,
		trackEnabled: track.enabled,
		trackMuted: track.muted,
		trackReadyState: track.readyState,
	};
	for (const key of [
		"autoGainControl",
		"channelCount",
		"deviceId",
		"echoCancellation",
		"groupId",
		"noiseSuppression",
		"sampleRate",
		"sampleSize",
	] as const) {
		const value = settings[key];
		if (value !== undefined) {
			snapshot[key] = value as never;
		}
	}

	return Object.keys(snapshot).length > 0 ? snapshot : null;
}

async function createAudioInputDeviceSnapshot(): Promise<
	MicrophoneAudioInputDeviceSnapshot[] | null
> {
	if (typeof navigator.mediaDevices?.enumerateDevices !== "function") {
		return null;
	}

	const devices = await navigator.mediaDevices.enumerateDevices();
	const audioInputs = devices
		.filter((device) => device.kind === "audioinput")
		.map((device) => ({
			deviceId: device.deviceId,
			...(device.groupId ? { groupId: device.groupId } : {}),
			label: device.label,
		}));

	return audioInputs.length > 0 ? audioInputs : null;
}

export function useScreenRecorder(): UseScreenRecorderReturn {
	const [recording, setRecording] = useState(false);
	const [paused, setPaused] = useState(false);
	const [starting, setStarting] = useState(false);
	const [finalizing, setFinalizing] = useState(false);
	const [countdownActive, setCountdownActive] = useState(false);
	const [isMacOS, setIsMacOS] = useState(false);
	const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
	const [microphoneDeviceId, setMicrophoneDeviceId] = useState<string | undefined>(undefined);
	const [systemAudioEnabled, setSystemAudioEnabled] = useState(false);
	const [webcamEnabled, setWebcamEnabled] = useState(false);
	const [webcamDeviceIds, setWebcamDeviceIdsState] = useState<string[]>([]);
	const [countdownDelay, setCountdownDelayState] = useState(3);
	const [recordingQuality, setRecordingQualityState] = useState<RecordingQuality>("4k");
	const mediaRecorder = useRef<MediaRecorder | null>(null);
	const webcamSlots = useRef<WebcamCaptureSlot[]>([]);
	const stream = useRef<MediaStream | null>(null);
	const screenStream = useRef<MediaStream | null>(null);
	const microphoneStream = useRef<MediaStream | null>(null);
	const mixingContext = useRef<AudioContext | null>(null);
	const chunks = useRef<Blob[]>([]);
	const startTime = useRef<number>(0);
	const recordingSessionTimestamp = useRef<number | null>(null);
	const nativeScreenRecording = useRef(false);
	const nativeWindowsRecording = useRef(false);
	const startInFlight = useRef(false);
	const startInFlightTimestamp = useRef(0);
	const hasPromptedForReselect = useRef(false);
	const hasShownNativeWindowsFallbackToast = useRef(false);
	const countdownDelayLoaded = useRef(false);
	const recordingPrefsLoaded = useRef(false);
	const pendingWebcamTracksPromise = useRef<Promise<WebcamTrackResult[]> | null>(null);
	const resolvedWebcamTracks = useRef<WebcamTrackResult[]>([]);
	const accumulatedPausedDurationMs = useRef(0);
	const pauseStartedAtMs = useRef<number | null>(null);
	const micFallbackRecorder = useRef<MediaRecorder | null>(null);
	const micFallbackChunks = useRef<Blob[]>([]);
	const micFallbackStartDelayMs = useRef<number | null>(null);
	const micFallbackTrackSettings = useRef<MicrophoneTrackSettingsSnapshot | null>(null);
	const micFallbackRequestedConstraints = useRef<MediaStreamConstraints | null>(null);
	const micFallbackAudioInputDevices = useRef<MicrophoneAudioInputDeviceSnapshot[] | null>(null);
	const micFallbackRecorderMetadata = useRef<MicrophoneFallbackRecorderMetadata | null>(null);
	const micFallbackChunkEvents = useRef<MicrophoneFallbackChunkEvent[]>([]);
	const micFallbackRecorderStartedAt = useRef<number | null>(null);
	const micFallbackPauseStartedAt = useRef<number | null>(null);
	const micFallbackPausedDurationMs = useRef(0);
	const micFallbackPauseIntervals = useRef<MicrophoneFallbackPauseInterval[]>([]);
	const browserMicrophoneProfile = useRef<BrowserMicrophoneProfile>(
		DEFAULT_BROWSER_MICROPHONE_PROFILE,
	);
	const requestedBrowserMicrophoneProfile = useRef<string | null>(null);
	const hideEditorOverlayCursorByDefault = useRef(false);

	const setWebcamDeviceIds = useCallback((deviceIds: string[]) => {
		setWebcamDeviceIdsState(deviceIds.slice(0, MAX_WEBCAM_DEVICES));
	}, []);

	const webcamDeviceId = webcamDeviceIds[0];
	const setWebcamDeviceId = useCallback((deviceId: string | undefined) => {
		setWebcamDeviceIdsState((previous) => {
			if (deviceId === undefined) {
				return previous.length > 0 ? [] : previous;
			}
			// Preserve a selected secondary camera when only the primary changes.
			return [deviceId, ...previous.slice(1).filter((id) => id !== deviceId)];
		});
	}, []);

	const notifyRecordingFinalizationFailure = useCallback(async (message: string) => {
		setFinalizing(false);
		toast.error(message, { duration: 10000 });
	}, []);

	const logNativeCaptureDiagnostics = useCallback(async (context: string) => {
		if (typeof window.electronAPI?.getLastNativeCaptureDiagnostics !== "function") {
			return;
		}

		try {
			const result = await window.electronAPI.getLastNativeCaptureDiagnostics();
			if (result.success && result.diagnostics) {
				console.warn(`[NativeCaptureDiagnostics:${context}]`, result.diagnostics);
			}
		} catch (error) {
			console.warn("Failed to load native capture diagnostics:", error);
		}
	}, []);

	const buildNativeCaptureFailureMessage = useCallback(
		async (context: string, fallbackMessage: string) => {
			if (typeof window.electronAPI?.getLastNativeCaptureDiagnostics !== "function") {
				return fallbackMessage;
			}

			try {
				const result = await window.electronAPI.getLastNativeCaptureDiagnostics();
				const diagnostics = result.success ? (result.diagnostics ?? null) : null;
				if (!diagnostics) {
					return fallbackMessage;
				}

				console.warn(`[NativeCaptureDiagnostics:${context}]`, diagnostics);

				const details: string[] = [];
				if (diagnostics.error) {
					details.push(diagnostics.error);
				}
				if (diagnostics.outputPath) {
					details.push(`Saved file: ${diagnostics.outputPath}`);
				}

				return details.length > 0
					? `${fallbackMessage} ${details.join(". ")}`
					: fallbackMessage;
			} catch (error) {
				console.warn("Failed to load native capture diagnostics:", error);
				return fallbackMessage;
			}
		},
		[],
	);

	const resetRecordingClock = useCallback((startedAt: number) => {
		startTime.current = startedAt;
		accumulatedPausedDurationMs.current = 0;
		pauseStartedAtMs.current = null;
	}, []);

	const markRecordingPaused = useCallback((pausedAt: number) => {
		if (pauseStartedAtMs.current === null) {
			pauseStartedAtMs.current = pausedAt;
		}
	}, []);

	const markRecordingResumed = useCallback((resumedAt: number) => {
		if (pauseStartedAtMs.current === null) {
			return;
		}

		const pauseStart = pauseStartedAtMs.current;
		const pauseDurationMs = Math.max(0, resumedAt - pauseStart);
		accumulatedPausedDurationMs.current += pauseDurationMs;
		pauseStartedAtMs.current = null;
	}, []);

	const getRecordingDurationMs = useCallback((endedAt: number) => {
		return getEffectiveRecordingDurationMs({
			startTimeMs: startTime.current,
			endTimeMs: endedAt,
			accumulatedPausedDurationMs: accumulatedPausedDurationMs.current,
			pauseStartedAtMs: pauseStartedAtMs.current,
		});
	}, []);

	const getMicFallbackRecordedElapsedMs = useCallback((now = performance.now()) => {
		const startedAt = micFallbackRecorderStartedAt.current;
		if (startedAt === null) {
			return 0;
		}

		const currentPauseDurationMs =
			micFallbackPauseStartedAt.current === null
				? 0
				: Math.max(0, now - micFallbackPauseStartedAt.current);
		return Math.max(
			0,
			Math.round(
				now - startedAt - micFallbackPausedDurationMs.current - currentPauseDurationMs,
			),
		);
	}, []);

	const resetMicFallbackTimingDiagnostics = useCallback(() => {
		micFallbackChunkEvents.current = [];
		micFallbackRecorderStartedAt.current = null;
		micFallbackPauseStartedAt.current = null;
		micFallbackPausedDurationMs.current = 0;
		micFallbackPauseIntervals.current = [];
	}, []);

	const preparePermissions = useCallback(async (options: { startup?: boolean } = {}) => {
		const platform = await window.electronAPI.getPlatform();
		if (platform !== "darwin") {
			return true;
		}

		const screenPermission = await window.electronAPI.getScreenRecordingPermissionStatus();
		if (!screenPermission.success || screenPermission.status !== "granted") {
			await window.electronAPI.openScreenRecordingPreferences();
			alert(
				options.startup
					? "Zidan Record needs Screen Recording permission before you start. System Settings has been opened. After enabling it, quit and reopen Zidan Record."
					: "Screen Recording permission is still missing. System Settings has been opened again. Enable it, then quit and reopen Zidan Record before recording.",
			);
			return false;
		}

		const accessibilityPermission = await window.electronAPI.getAccessibilityPermissionStatus();
		if (!accessibilityPermission.success) {
			return false;
		}

		if (accessibilityPermission.trusted) {
			return true;
		}

		const requestedAccessibility = await window.electronAPI.requestAccessibilityPermission();
		if (requestedAccessibility.success && requestedAccessibility.trusted) {
			return true;
		}

		await window.electronAPI.openAccessibilityPreferences();
		alert(
			options.startup
				? "Zidan Record also needs Accessibility permission for cursor tracking. System Settings has been opened. After enabling it, quit and reopen Zidan Record."
				: "Accessibility permission is still missing. System Settings has been opened again. Enable it, then quit and reopen Zidan Record before recording.",
		);

		return false;
	}, []);

	const selectMimeType = useCallback(() => {
		return selectRecordingMimeType();
	}, []);

	const selectWebcamMimeType = useCallback(() => {
		return selectWebcamRecordingMimeType();
	}, []);

	const computeBitrate = (width: number, height: number) => {
		const pixels = width * height;
		const highFrameRateBoost =
			TARGET_FRAME_RATE >= HIGH_FRAME_RATE_THRESHOLD ? HIGH_FRAME_RATE_BOOST : 1;

		if (pixels >= FOUR_K_PIXELS) {
			return Math.round(BITRATE_4K * highFrameRateBoost);
		}

		if (pixels >= QHD_PIXELS) {
			return Math.round(BITRATE_QHD * highFrameRateBoost);
		}

		return Math.round(BITRATE_BASE * highFrameRateBoost);
	};

	const cleanupCapturedMedia = useCallback(() => {
		if (stream.current) {
			stream.current.getTracks().forEach((track) => track.stop());
			stream.current = null;
		}

		if (screenStream.current) {
			screenStream.current.getTracks().forEach((track) => track.stop());
			screenStream.current = null;
		}

		if (microphoneStream.current) {
			microphoneStream.current.getTracks().forEach((track) => track.stop());
			microphoneStream.current = null;
		}

		for (const slot of webcamSlots.current) {
			if (slot.stream) {
				slot.stream.getTracks().forEach((track) => track.stop());
				slot.stream = null;
			}
		}

		if (mixingContext.current) {
			mixingContext.current.close().catch(() => undefined);
			mixingContext.current = null;
		}

		if (micFallbackRecorder.current) {
			try {
				if (micFallbackRecorder.current.state !== "inactive") {
					micFallbackRecorder.current.stop();
				}
				micFallbackRecorder.current.stream?.getTracks().forEach((track) => track.stop());
			} catch {
				/* ignore */
			}
			micFallbackRecorder.current = null;
			micFallbackChunks.current = [];
			micFallbackTrackSettings.current = null;
			micFallbackRequestedConstraints.current = null;
			micFallbackAudioInputDevices.current = null;
			micFallbackRecorderMetadata.current = null;
			resetMicFallbackTimingDiagnostics();
		}
	}, [resetMicFallbackTimingDiagnostics]);

	const appendMicFallbackChunk = useCallback(
		(event: BlobEvent) => {
			if (event.data.size <= 0) {
				return;
			}

			micFallbackChunks.current.push(event.data);
			const startedAt = micFallbackRecorderStartedAt.current;
			if (startedAt === null) {
				return;
			}

			const now = performance.now();
			const elapsedMs = Math.max(0, Math.round(now - startedAt));
			const recordedElapsedMs = getMicFallbackRecordedElapsedMs(now);
			const previous =
				micFallbackChunkEvents.current[micFallbackChunkEvents.current.length - 1];
			micFallbackChunkEvents.current.push({
				index: micFallbackChunkEvents.current.length,
				size: event.data.size,
				elapsedMs,
				deltaMs: previous ? Math.max(0, elapsedMs - previous.elapsedMs) : null,
				recordedElapsedMs,
				recordedDeltaMs: previous
					? Math.max(0, recordedElapsedMs - previous.recordedElapsedMs)
					: null,
			});
		},
		[getMicFallbackRecordedElapsedMs],
	);

	const resolveBrowserCaptureSource = useCallback(async (source: ProcessedDesktopSource) => {
		if (!source?.id?.startsWith("screen:")) {
			return source;
		}

		// Linux/Wayland portal sentinel: do NOT call getSources here, because
		// on Wayland that triggers an additional xdg-desktop-portal dialog.
		// The sentinel is handled later by routing through getDisplayMedia,
		// which lets the portal pick the source in a single dialog.
		if (source.id === "screen:linux-portal") {
			return source;
		}

		try {
			const liveSources = await window.electronAPI.getSources({
				types: ["screen"],
				thumbnailSize: { width: 1, height: 1 },
				fetchWindowIcons: false,
			});

			const exactMatch = liveSources.find((candidate) => candidate.id === source.id);
			if (exactMatch) {
				return {
					...source,
					id: exactMatch.id,
					name: exactMatch.name ?? source.name,
					display_id: exactMatch.display_id ?? source.display_id,
				};
			}

			const displayMatch = liveSources.find(
				(candidate) =>
					String(candidate.display_id ?? "") === String(source.display_id ?? ""),
			);
			if (displayMatch) {
				return {
					...source,
					id: displayMatch.id,
					name: displayMatch.name ?? source.name,
					display_id: displayMatch.display_id ?? source.display_id,
				};
			}
		} catch (error) {
			console.warn("Failed to resolve browser capture source:", error);
		}

		return source;
	}, []);

	const finalizeRecordingSession = useCallback(
		async (videoPath: string, webcamTracks: WebcamTrackResult[] | null) => {
			const start = performance.now();
			console.log("[PERF:RENDERER] Finalize Session & Switch to Editor: STARTED");
			const shouldHideOverlayCursor = hideEditorOverlayCursorByDefault.current;
			try {
				if (webcamTracks && webcamTracks.length > 0) {
					await window.electronAPI.setCurrentRecordingSession({
						videoPath,
						webcamPath: webcamTracks[0].path,
						timeOffsetMs: webcamTracks[0].timeOffsetMs,
						webcams: webcamTracks,
						hideOverlayCursorByDefault: shouldHideOverlayCursor,
					});
				} else {
					await window.electronAPI.setCurrentVideoPath(videoPath, {
						hideOverlayCursorByDefault: shouldHideOverlayCursor,
					});
				}
			} catch (error) {
				console.error("Failed to persist recording session metadata:", error);

				try {
					await window.electronAPI.setCurrentVideoPath(videoPath, {
						hideOverlayCursorByDefault: shouldHideOverlayCursor,
					});
				} catch (fallbackError) {
					console.error("Failed to persist fallback video path:", fallbackError);
				}
			}

			setFinalizing(false);
			await window.electronAPI.switchToEditor();
			console.log(
				`[PERF:RENDERER] Finalize Session & Switch to Editor: COMPLETED in ${(performance.now() - start).toFixed(2)}ms`,
			);
		},
		[],
	);

	const closeMicFallbackPauseInterval = useCallback((now = performance.now()) => {
		const pauseStartedAt = micFallbackPauseStartedAt.current;
		if (pauseStartedAt === null) {
			return;
		}

		const durationMs = Math.max(0, Math.round(now - pauseStartedAt));
		micFallbackPausedDurationMs.current += durationMs;
		const startedAt = micFallbackRecorderStartedAt.current ?? now;
		const lastInterval =
			micFallbackPauseIntervals.current[micFallbackPauseIntervals.current.length - 1];
		if (lastInterval && lastInterval.endElapsedMs === undefined) {
			lastInterval.endElapsedMs = Math.max(
				lastInterval.startElapsedMs,
				Math.round(now - startedAt),
			);
			lastInterval.durationMs = durationMs;
		}
		micFallbackPauseStartedAt.current = null;
	}, []);

	const stopMicFallbackRecorder = useCallback((): Promise<Blob | null> => {
		return new Promise((resolve) => {
			const recorder = micFallbackRecorder.current;
			if (!recorder || recorder.state === "inactive") {
				micFallbackRecorder.current = null;
				resolve(null);
				return;
			}
			closeMicFallbackPauseInterval();
			recorder.ondataavailable = appendMicFallbackChunk;
			recorder.onstop = () => {
				const blob =
					micFallbackChunks.current.length > 0
						? new Blob(micFallbackChunks.current, { type: recorder.mimeType })
						: null;
				micFallbackChunks.current = [];
				recorder.stream.getTracks().forEach((track) => track.stop());
				micFallbackRecorder.current = null;
				micFallbackRecorderStartedAt.current = null;
				resolve(blob);
			};
			recorder.stop();
		});
	}, [appendMicFallbackChunk, closeMicFallbackPauseInterval]);

	const pauseMicFallbackRecorder = useCallback(() => {
		const recorder = micFallbackRecorder.current;
		if (recorder?.state !== "recording") {
			return;
		}

		try {
			recorder.requestData();
		} catch (error) {
			console.warn("Failed to flush microphone fallback chunk before pause:", error);
		}

		recorder.pause();
		const now = performance.now();
		const startedAt = micFallbackRecorderStartedAt.current ?? now;
		micFallbackPauseStartedAt.current = now;
		micFallbackPauseIntervals.current.push({
			startElapsedMs: Math.max(0, Math.round(now - startedAt)),
		});
	}, []);

	const resumeMicFallbackRecorder = useCallback(() => {
		const recorder = micFallbackRecorder.current;
		if (recorder?.state !== "paused") {
			return;
		}

		closeMicFallbackPauseInterval();
		recorder.resume();
	}, [closeMicFallbackPauseInterval]);

	const storeMicrophoneSidecar = useCallback(
		async (
			micFallbackBlobPromise: Promise<Blob | null> | null | undefined,
			finalPath: string,
			startDelayMs?: number | null,
			mediaTrackSettings?: MicrophoneTrackSettingsSnapshot | null,
		) => {
			const micFallbackBlob = await micFallbackBlobPromise;
			if (!micFallbackBlob) {
				micFallbackStartDelayMs.current = null;
				micFallbackTrackSettings.current = null;
				micFallbackRequestedConstraints.current = null;
				micFallbackAudioInputDevices.current = null;
				micFallbackRecorderMetadata.current = null;
				resetMicFallbackTimingDiagnostics();
				return;
			}

			try {
				const arrayBuffer = await micFallbackBlob.arrayBuffer();
				const effectiveStartDelayMs = startDelayMs ?? micFallbackStartDelayMs.current;
				const effectiveTrackSettings =
					mediaTrackSettings ?? micFallbackTrackSettings.current;
				const sidecarOptions: MicrophoneSidecarOptions = {
					...(Number.isFinite(effectiveStartDelayMs) && (effectiveStartDelayMs ?? 0) >= 0
						? { startDelayMs: effectiveStartDelayMs ?? 0 }
						: {}),
					browserMicrophoneProfile: browserMicrophoneProfile.current,
					...(requestedBrowserMicrophoneProfile.current
						? {
								requestedBrowserMicrophoneProfile:
									requestedBrowserMicrophoneProfile.current,
							}
						: {}),
					...(micFallbackRequestedConstraints.current
						? { requestedConstraints: micFallbackRequestedConstraints.current }
						: {}),
					...(effectiveTrackSettings
						? { mediaTrackSettings: effectiveTrackSettings }
						: {}),
					...(micFallbackAudioInputDevices.current
						? { audioInputDevices: micFallbackAudioInputDevices.current }
						: {}),
					...(micFallbackRecorderMetadata.current
						? { mediaRecorder: micFallbackRecorderMetadata.current }
						: {}),
					...(micFallbackChunkEvents.current.length > 0
						? { chunkEvents: [...micFallbackChunkEvents.current] }
						: {}),
					...(micFallbackPauseIntervals.current.length > 0
						? {
								pauseIntervals: micFallbackPauseIntervals.current.map(
									(interval) => ({ ...interval }),
								),
							}
						: {}),
				};
				const result = await window.electronAPI.storeMicrophoneSidecar(
					arrayBuffer,
					finalPath,
					sidecarOptions,
				);
				if (!result.success) {
					const errorMessage =
						result.error || "Failed to save the fallback microphone audio track";
					console.warn("Failed to store microphone sidecar:", errorMessage);
					toast.error(
						`${errorMessage}. Recording was saved without the fallback microphone track.`,
						{ id: MICROPHONE_SIDECAR_ERROR_TOAST_ID, duration: 10000 },
					);
				}
			} catch (error) {
				console.warn("Failed to store microphone sidecar:", error);
				toast.error(
					`${getErrorMessage(error)}. Recording was saved without the fallback microphone track.`,
					{ id: MICROPHONE_SIDECAR_ERROR_TOAST_ID, duration: 10000 },
				);
			} finally {
				micFallbackStartDelayMs.current = null;
				micFallbackTrackSettings.current = null;
				micFallbackRequestedConstraints.current = null;
				micFallbackAudioInputDevices.current = null;
				micFallbackRecorderMetadata.current = null;
				resetMicFallbackTimingDiagnostics();
			}
		},
		[resetMicFallbackTimingDiagnostics],
	);

	const stopWebcamRecorder = useCallback(async (): Promise<WebcamTrackResult[]> => {
		const slots = webcamSlots.current;
		if (slots.length === 0) {
			const pending = pendingWebcamTracksPromise.current;
			const result = pending ? await pending : resolvedWebcamTracks.current;
			pendingWebcamTracksPromise.current = null;
			resolvedWebcamTracks.current = result;
			return result;
		}

		for (const slot of slots) {
			if (slot.recorder && slot.recorder.state !== "inactive") {
				slot.recorder.stop();
			} else if (slot.stopResolver) {
				slot.stopResolver(slot.resolvedPath);
				slot.stopResolver = null;
			}
		}

		const paths = await Promise.all(
			slots.map((slot) =>
				slot.stopPromise ? slot.stopPromise : Promise.resolve(slot.resolvedPath),
			),
		);

		const tracks: WebcamTrackResult[] = [];
		slots.forEach((slot, index) => {
			const path = paths[index];
			if (path) {
				tracks.push({
					path,
					timeOffsetMs: slot.timeOffsetMs,
					...(slot.label ? { deviceLabel: slot.label } : {}),
				});
			}
		});

		webcamSlots.current = [];
		pendingWebcamTracksPromise.current = null;
		resolvedWebcamTracks.current = tracks;
		return tracks;
	}, []);

	const recoverNativeRecordingSession = useCallback(
		async (
			micFallbackBlobPromise?: Promise<Blob | null> | null,
			startDelayMs?: number | null,
		) => {
			if (typeof window.electronAPI?.recoverNativeScreenRecording !== "function") {
				return null;
			}

			const result = await window.electronAPI.recoverNativeScreenRecording();
			if (!result.success || !result.path) {
				return null;
			}

			const resolvedMicFallbackBlobPromise =
				micFallbackBlobPromise ?? stopMicFallbackRecorder();
			const webcamTracks = await stopWebcamRecorder();
			await storeMicrophoneSidecar(resolvedMicFallbackBlobPromise, result.path, startDelayMs);
			await finalizeRecordingSession(result.path, webcamTracks);

			if (typeof window.electronAPI?.hudOverlayClose === "function") {
				window.electronAPI.hudOverlayClose();
			}

			return result.path;
		},
		[
			finalizeRecordingSession,
			stopMicFallbackRecorder,
			stopWebcamRecorder,
			storeMicrophoneSidecar,
		],
	);

	/**
	 * Acquire the webcam streams and prepare a MediaRecorder per selected
	 * camera, but do NOT start recording yet. Call {@link beginWebcamCapture}
	 * after the main recording has started so all begin at approximately the
	 * same time.
	 */
	const prepareWebcamRecorders = useCallback(async () => {
		webcamSlots.current = [];
		resolvedWebcamTracks.current = [];
		pendingWebcamTracksPromise.current = null;

		if (!webcamEnabled) {
			return;
		}

		const deviceIds: (string | undefined)[] =
			webcamDeviceIds.length > 0
				? webcamDeviceIds.slice(0, MAX_WEBCAM_DEVICES)
				: [undefined];

		for (let slotIndex = 0; slotIndex < deviceIds.length; slotIndex++) {
			const deviceId = deviceIds[slotIndex];
			const idealWidth = slotIndex === 0 ? WEBCAM_WIDTH : SECONDARY_WEBCAM_WIDTH;
			const idealHeight = slotIndex === 0 ? WEBCAM_HEIGHT : SECONDARY_WEBCAM_HEIGHT;

			let slotStream: MediaStream;
			try {
				slotStream = await navigator.mediaDevices.getUserMedia({
					video: {
						...(deviceId ? { deviceId: { exact: deviceId } } : {}),
						width: { ideal: idealWidth },
						height: { ideal: idealHeight },
						frameRate: { ideal: WEBCAM_FRAME_RATE, max: WEBCAM_FRAME_RATE },
					},
					audio: false,
				});
			} catch (error) {
				if (slotIndex === 0) {
					console.warn(
						"Failed to start webcam recording; continuing without webcam layer:",
						error,
					);
				} else {
					console.warn("Failed to start secondary webcam; continuing with one camera:", error);
					toast.error(
						"The second camera could not be started. Recording continues with one camera.",
						{ id: SECONDARY_WEBCAM_ERROR_TOAST_ID, duration: 8000 },
					);
				}
				continue;
			}

			const mimeType = selectWebcamMimeType();
			const suffix = WEBCAM_SUFFIXES[webcamSlots.current.length];

			// Scale bitrate to the resolution the camera actually delivered.
			const webcamTrackSettings = slotStream.getVideoTracks()[0]?.getSettings?.();
			const webcamPixels =
				(webcamTrackSettings?.width ?? idealWidth) *
				(webcamTrackSettings?.height ?? idealHeight);
			const webcamBitrate =
				webcamPixels > 2560 * 1440
					? 40_000_000
					: webcamPixels > 1920 * 1080
						? 24_000_000
						: webcamPixels > 1280 * 720
							? 14_000_000
							: WEBCAM_BITRATE;

			const recorder = new MediaRecorder(slotStream, {
				videoBitsPerSecond: webcamBitrate,
				...(mimeType ? { mimeType } : {}),
			});

			const slot: WebcamCaptureSlot = {
				deviceId,
				label: slotStream.getVideoTracks()[0]?.label || null,
				stream: slotStream,
				recorder,
				chunks: [],
				startTime: null,
				timeOffsetMs: 0,
				resolvedPath: null,
				stopPromise: null,
				stopResolver: null,
			};
			slot.stopPromise = new Promise((resolve) => {
				slot.stopResolver = (path) => {
					slot.resolvedPath = path;
					resolve(path);
				};
			});
			webcamSlots.current.push(slot);

			recorder.ondataavailable = (event) => {
				if (event.data && event.data.size > 0) {
					slot.chunks.push(event.data);
				}
			};
			recorder.onerror = () => {
				slot.stopResolver?.(null);
				slot.stopResolver = null;
			};
			recorder.onstop = async () => {
				const sessionTimestamp = recordingSessionTimestamp.current ?? Date.now();
				const webcamMimeType = recorder.mimeType || mimeType;
				const webcamFileName = `${RECORDING_FILE_PREFIX}${sessionTimestamp}${suffix}${getVideoExtensionForMimeType(webcamMimeType)}`;

				try {
					if (slot.chunks.length === 0) {
						slot.stopResolver?.(null);
						return;
					}

					const duration = Math.max(
						0,
						getRecordingDurationMs(Date.now()) - slot.timeOffsetMs,
					);
					const webcamBlob = new Blob(
						slot.chunks,
						webcamMimeType ? { type: webcamMimeType } : undefined,
					);
					slot.chunks = [];
					const finalBlob = isWebmMimeType(webcamMimeType)
						? await fixWebmDuration(webcamBlob, duration)
						: webcamBlob;
					const arrayBuffer = await finalBlob.arrayBuffer();
					const result = await window.electronAPI.storeRecordedVideo(
						arrayBuffer,
						webcamFileName,
					);
					slot.stopResolver?.(result.success ? (result.path ?? null) : null);
				} catch (error) {
					console.error("Error saving webcam recording:", error);
					slot.stopResolver?.(null);
				} finally {
					slot.stopResolver = null;
					slot.recorder = null;
					slot.startTime = null;
					if (slot.stream) {
						slot.stream.getTracks().forEach((track) => track.stop());
						slot.stream = null;
					}
				}
			};
		}
	}, [getRecordingDurationMs, selectWebcamMimeType, webcamDeviceIds, webcamEnabled]);

	/** Start the prepared webcam MediaRecorders. Call after main recording begins. */
	const beginWebcamCapture = useCallback(() => {
		for (const slot of webcamSlots.current) {
			if (slot.recorder && slot.recorder.state === "inactive") {
				slot.startTime = Date.now();
				slot.recorder.start(RECORDER_TIMESLICE_MS);
			}
		}
	}, []);

	/** Record each camera's start offset relative to the main capture start. */
	const applyWebcamTimeOffsets = useCallback((mainStartedAt: number) => {
		for (const slot of webcamSlots.current) {
			slot.timeOffsetMs = slot.startTime === null ? 0 : slot.startTime - mainStartedAt;
		}
	}, []);

	const stopRecording = useRef(() => {
		setPaused(false);
		if (nativeScreenRecording.current) {
			nativeScreenRecording.current = false;
			setRecording(false);
			setFinalizing(true);

			void (async () => {
				const stopStart = performance.now();
				console.log("[PERF:RENDERER] Total Stop Sequence: STARTED");

				const fallbackStartDelayMs = micFallbackStartDelayMs.current;
				const fallbackTrackSettings = micFallbackTrackSettings.current;
				const stoppedAtMs = Date.now();
				markRecordingResumed(stoppedAtMs);
				const expectedDurationMs = getRecordingDurationMs(stoppedAtMs);
				const micFallbackBlobPromise = stopMicFallbackRecorder();
				const webcamTracksPromise = stopWebcamRecorder();
				const isNativeWindows = nativeWindowsRecording.current;
				nativeWindowsRecording.current = false;

				const ipcStopStart = performance.now();
				console.log("[PERF:RENDERER] IPC: stopNativeScreenRecording: STARTED");
				const result = await window.electronAPI.stopNativeScreenRecording();
				console.log(
					`[PERF:RENDERER] IPC: stopNativeScreenRecording: COMPLETED in ${(performance.now() - ipcStopStart).toFixed(2)}ms`,
				);

				await window.electronAPI?.setRecordingState(false);

				if (!result.success || !result.path) {
					console.error(
						"Failed to stop native screen recording:",
						result.error ?? result.message,
					);
					void logNativeCaptureDiagnostics("stop-native-screen-recording");
					try {
						const recoveredPath = await recoverNativeRecordingSession(
							micFallbackBlobPromise,
							fallbackStartDelayMs,
						);
						if (recoveredPath) {
							console.log(
								`[PERF:RENDERER] Total Stop Sequence (RECOVERED) in ${(performance.now() - stopStart).toFixed(2)}ms`,
							);
							return;
						}
					} catch (recoveryError) {
						console.error("Failed to recover native screen recording:", recoveryError);
					}

					const failureMessage = await buildNativeCaptureFailureMessage(
						"stop-native-screen-recording",
						isMacOS
							? "Failed to finish the macOS recording, so the editor was not opened."
							: "Failed to finish the recording, so the editor was not opened.",
					);
					await notifyRecordingFinalizationFailure(failureMessage);
					return;
				}

				const finalPath = result.path;

				// 1. Finalize the session and switch to editor immediately (Optimistic UI)
				// We pass null for webcamPath initially to avoid blocking on webcam disk writes/muxing.
				await finalizeRecordingSession(finalPath, null);

				// 2. Perform background finalization (webcam, muxing, sidecars)
				// We don't await this to keep the UI responsive
				void (async () => {
					try {
						// Await the webcam tracks in the background
						const webcamTracks = await webcamTracksPromise;
						console.log(
							"[useScreenRecorder] Background native processing: webcamTracks are",
							webcamTracks,
						);

						// Store sidecars
						await storeMicrophoneSidecar(
							micFallbackBlobPromise,
							finalPath,
							fallbackStartDelayMs,
							fallbackTrackSettings,
						);

						// Perform muxing/renaming if on Windows
						if (isNativeWindows) {
							await window.electronAPI.muxNativeWindowsRecording(expectedDurationMs);
						}

						console.log(
							"[useScreenRecorder] Emitting setCurrentRecordingSession with:",
							{ finalPath, webcamTracks },
						);

						// Update the session state to notify the editor that all background assets (webcam, mic, etc.) are now ready.
						// This broadcasts a 'recording-session-changed' event that the open editor listens to for re-scanning assets.
						await window.electronAPI.setCurrentRecordingSession({
							videoPath: finalPath,
							webcamPath: webcamTracks[0]?.path ?? null,
							timeOffsetMs: webcamTracks[0]?.timeOffsetMs ?? 0,
							...(webcamTracks.length > 0 ? { webcams: webcamTracks } : {}),
							hideOverlayCursorByDefault: hideEditorOverlayCursorByDefault.current,
						});

						console.log(
							`[PERF:RENDERER] Background Stop Sequence: COMPLETED in ${(performance.now() - stopStart).toFixed(2)}ms`,
						);
					} catch (bgError) {
						console.error("Error in background finalization:", bgError);
					} finally {
						// After all background tasks are done (webcam, mic sidecars, muxing),
						// we can safely close the HUD window to release hardware and resources.
						if (typeof window.electronAPI?.hudOverlayClose === "function") {
							console.log(
								"[useScreenRecorder] All background tasks finished, closing HUD",
							);
							window.electronAPI.hudOverlayClose();
						}
					}
				})();
			})();
			return;
		}

		const recorder = mediaRecorder.current;
		const recorderState = recorder?.state;
		if (recorder && (recorderState === "recording" || recorderState === "paused")) {
			if (recorderState === "paused") {
				try {
					recorder.resume();
					markRecordingResumed(Date.now());
				} catch (error) {
					console.warn("Failed to resume recorder before stopping:", error);
				}
			}
			pendingWebcamTracksPromise.current = stopWebcamRecorder();
			try {
				recorder.requestData();
			} catch (error) {
				console.warn("Failed to flush recorder before stopping:", error);
			}
			recorder.stop();
			setRecording(false);
			setFinalizing(true);
			window.electronAPI?.setRecordingState(false);
		}
	});

	useEffect(() => {
		void (async () => {
			const platform = await window.electronAPI.getPlatform();
			setIsMacOS(platform === "darwin");
		})();
	}, []);

	useEffect(() => {
		if (typeof window.electronAPI?.getRecordingAudioLabConfig !== "function") {
			return;
		}

		void (async () => {
			const result = await window.electronAPI.getRecordingAudioLabConfig();
			browserMicrophoneProfile.current = normalizeBrowserMicrophoneProfile(
				result.browserMicrophoneProfile,
			);
			requestedBrowserMicrophoneProfile.current =
				result.requestedBrowserMicrophoneProfile ?? null;
			console.info("Browser microphone profile:", browserMicrophoneProfile.current);
		})();
	}, []);

	useEffect(() => {
		if (countdownDelayLoaded.current) return;
		countdownDelayLoaded.current = true;

		void (async () => {
			const result = await window.electronAPI.getCountdownDelay();
			if (result.success && typeof result.delay === "number") {
				setCountdownDelayState(result.delay);
			}
		})();
	}, []);

	const setCountdownDelay = useCallback((delay: number) => {
		setCountdownDelayState(delay);
		void window.electronAPI.setCountdownDelay(delay);
	}, []);

	useEffect(() => {
		if (recordingPrefsLoaded.current) return;
		recordingPrefsLoaded.current = true;

		void (async () => {
			const result = await window.electronAPI.getRecordingPreferences();
			if (result.success) {
				setMicrophoneEnabled(result.microphoneEnabled);
				if (result.microphoneDeviceId) {
					setMicrophoneDeviceId(result.microphoneDeviceId);
				}
				setSystemAudioEnabled(result.systemAudioEnabled);
				if (result.recordingQuality) {
					setRecordingQualityState(result.recordingQuality as RecordingQuality);
				}
			}
		})();
	}, []);

	const persistMicrophoneEnabled = useCallback((enabled: boolean) => {
		setMicrophoneEnabled(enabled);
		void window.electronAPI.setRecordingPreferences({ microphoneEnabled: enabled });
	}, []);

	const persistMicrophoneDeviceId = useCallback((deviceId: string | undefined) => {
		setMicrophoneDeviceId(deviceId);
		void window.electronAPI.setRecordingPreferences({ microphoneDeviceId: deviceId });
	}, []);

	const persistSystemAudioEnabled = useCallback((enabled: boolean) => {
		setSystemAudioEnabled(enabled);
		void window.electronAPI.setRecordingPreferences({ systemAudioEnabled: enabled });
	}, []);

	const persistRecordingQuality = useCallback((quality: RecordingQuality) => {
		setRecordingQualityState(quality);
		void window.electronAPI.setRecordingPreferences({ recordingQuality: quality });
	}, []);

	useEffect(() => {
		let cleanup: (() => void) | undefined;

		if (window.electronAPI?.onStopRecordingFromTray) {
			cleanup = window.electronAPI.onStopRecordingFromTray(() => {
				stopRecording.current();
			});
		}

		const removeRecordingStateListener = window.electronAPI?.onRecordingStateChanged?.(
			(state) => {
				setRecording(state.recording);
			},
		);

		const removeRecordingInterruptedListener = window.electronAPI?.onRecordingInterrupted?.(
			(state) => {
				void (async () => {
					setRecording(false);
					nativeScreenRecording.current = false;
					cleanupCapturedMedia();
					await window.electronAPI.setRecordingState(false);

					if (state.reason !== "window-unavailable") {
						try {
							const recoveredPath = await recoverNativeRecordingSession();
							if (recoveredPath) {
								return;
							}
						} catch (recoveryError) {
							console.error(
								"Failed to recover interrupted native screen recording:",
								recoveryError,
							);
						}
					}

					if (state.reason === "window-unavailable" && !hasPromptedForReselect.current) {
						hasPromptedForReselect.current = true;
						alert(state.message);
						await window.electronAPI.openSourceSelector();
					} else {
						console.error(state.message);
						toast.error(state.message);
					}
				})();
			},
		);

		return () => {
			cleanup?.();
			removeRecordingStateListener?.();
			removeRecordingInterruptedListener?.();

			if (nativeScreenRecording.current) {
				nativeScreenRecording.current = false;
				void window.electronAPI.stopNativeScreenRecording();
			}

			const recorder = mediaRecorder.current;
			const recorderState = recorder?.state;
			if (recorder && (recorderState === "recording" || recorderState === "paused")) {
				recorder.stop();
			}

			cleanupCapturedMedia();
		};
	}, [cleanupCapturedMedia, recoverNativeRecordingSession]);

	const startRecording = async () => {
		if (startInFlight.current) {
			if (Date.now() - startInFlightTimestamp.current > RECORDING_START_TIMEOUT_MS) {
				console.warn("Resetting stale startInFlight guard");
				startInFlight.current = false;
			} else {
				return;
			}
		}

		let hudSourceSelectionActive = false;
		const setHudSourceSelectionActive = (active: boolean) => {
			if (hudSourceSelectionActive === active) {
				return;
			}

			hudSourceSelectionActive = active;
			window.electronAPI?.hudOverlaySetSourceSelectionActive?.(active);
		};

		hasPromptedForReselect.current = false;
		startInFlight.current = true;
		startInFlightTimestamp.current = Date.now();
		setStarting(true);

		const masterTimeout = setTimeout(() => {
			if (startInFlight.current) {
				console.error("Recording start timed out after", RECORDING_START_TIMEOUT_MS, "ms");
				toast.error("Recording failed to start. Please try again.");
				setRecording(false);
				cleanupCapturedMedia();
				stopWebcamRecorder();
				startInFlight.current = false;
				setStarting(false);
			}
		}, RECORDING_START_TIMEOUT_MS);

		try {
			const platform = await window.electronAPI.getPlatform();
			hideEditorOverlayCursorByDefault.current = false;
			const existingSource = await window.electronAPI.getSelectedSource();
			const selectedSource =
				existingSource ?? (platform === "linux" ? LINUX_PORTAL_SOURCE : null);
			if (!selectedSource) {
				alert("Please select a source to record");
				return;
			}
			// Persist the synthetic Linux portal sentinel to main so that the
			// setDisplayMediaRequestHandler can short-circuit getSources() and
			// avoid triggering an extra portal dialog.
			if (!existingSource && selectedSource.id === "screen:linux-portal") {
				try {
					await window.electronAPI.selectSource(selectedSource);
				} catch (err) {
					console.warn("Failed to persist Linux portal sentinel source:", err);
				}
			}

			const permissionsReady = await preparePermissions();
			if (!permissionsReady) {
				return;
			}

			recordingSessionTimestamp.current = Date.now();
			resetRecordingClock(recordingSessionTimestamp.current);
			await prepareWebcamRecorders();
			const useNativeMacScreenCapture =
				platform === "darwin" &&
				(selectedSource.id?.startsWith("screen:") ||
					selectedSource.id?.startsWith("window:")) &&
				typeof window.electronAPI.startNativeScreenRecording === "function";

			let useNativeWindowsCapture = false;
			let nativeWindowsCaptureStartFailed = false;
			if (
				platform === "win32" &&
				shouldUseNativeWindowsCaptureForSource(selectedSource) &&
				typeof window.electronAPI.isNativeWindowsCaptureAvailable === "function"
			) {
				try {
					const nativeWindowsResult =
						await window.electronAPI.isNativeWindowsCaptureAvailable();
					useNativeWindowsCapture = nativeWindowsResult.available;
					if (!useNativeWindowsCapture && !hasShownNativeWindowsFallbackToast.current) {
						void logNativeCaptureDiagnostics("is-native-windows-capture-available");
						hasShownNativeWindowsFallbackToast.current = true;
						toast.info(
							"Native Windows capture is unavailable. Falling back to browser capture.",
						);
					}
				} catch {
					useNativeWindowsCapture = false;
					if (!hasShownNativeWindowsFallbackToast.current) {
						hasShownNativeWindowsFallbackToast.current = true;
						toast.info(
							"Unable to check native Windows capture. Falling back to browser capture.",
						);
					}
				}
			}

			if (useNativeMacScreenCapture || useNativeWindowsCapture) {
				// Resolve the selected mic label for native capture backends.
				let micLabel: string | undefined;
				if (microphoneEnabled) {
					try {
						const devices = await navigator.mediaDevices.enumerateDevices();
						const mic = devices.find(
							(d) => d.deviceId === microphoneDeviceId && d.kind === "audioinput",
						);
						micLabel = mic?.label || undefined;
					} catch {
						// Fall through — native process will use the default mic
					}
				}

				const nativeResult = await withTimeout(
					window.electronAPI.startNativeScreenRecording(
						selectedSource,
						{
							capturesSystemAudio: systemAudioEnabled,
							capturesMicrophone: microphoneEnabled,
							microphoneDeviceId,
							microphoneLabel: micLabel,
						},
					),
					NATIVE_CAPTURE_TIMEOUT_MS,
					"startNativeScreenRecording",
				);
				if (!nativeResult.success) {
					if (useNativeWindowsCapture) {
						nativeWindowsCaptureStartFailed = true;
						console.warn(
							"Native Windows capture failed, falling back to browser capture:",
							nativeResult.error ?? nativeResult.message,
						);
						void logNativeCaptureDiagnostics("start-native-screen-recording");
						if (!hasShownNativeWindowsFallbackToast.current) {
							hasShownNativeWindowsFallbackToast.current = true;
							toast.warning(
								"Native Windows capture failed to start. Falling back to browser capture.",
							);
						}
					} else if (!nativeResult.userNotified) {
						throw new Error(
							nativeResult.error ??
								nativeResult.message ??
								"Failed to start native screen recording",
						);
					} else {
						setRecording(false);
						cleanupCapturedMedia();
						await stopWebcamRecorder();
						return;
					}
				}

				if (nativeResult.success) {
					const mainStartedAt = Date.now();
					micFallbackStartDelayMs.current = null;
					beginWebcamCapture();
					nativeScreenRecording.current = true;
					nativeWindowsRecording.current = useNativeWindowsCapture;
					resetRecordingClock(mainStartedAt);
					applyWebcamTimeOffsets(mainStartedAt);

					// When native mic capture is unavailable or explicitly bypassed,
					// record mic via browser getUserMedia as a sidecar file.
					if (nativeResult.microphoneFallbackRequired && microphoneEnabled) {
						void logNativeCaptureDiagnostics("start-browser-microphone-fallback");
						console.info("Using browser microphone processing for this recording.");
						try {
							const microphoneConstraints = createProcessedMicrophoneConstraints(
								microphoneDeviceId,
								browserMicrophoneProfile.current,
							);
							micFallbackRequestedConstraints.current = microphoneConstraints;
							const micStream =
								await navigator.mediaDevices.getUserMedia(microphoneConstraints);
							micFallbackTrackSettings.current =
								createMicrophoneTrackSettingsSnapshot(micStream);
							micFallbackAudioInputDevices.current =
								await createAudioInputDeviceSnapshot().catch(() => null);
							console.info(
								"Browser microphone track settings:",
								micFallbackTrackSettings.current,
							);
							console.info(
								"Browser microphone audio input devices:",
								micFallbackAudioInputDevices.current,
							);
							micFallbackChunks.current = [];
							const recorder = new MediaRecorder(micStream, {
								mimeType: "audio/webm;codecs=opus",
								audioBitsPerSecond: AUDIO_BITRATE_VOICE,
							});
							micFallbackRecorderMetadata.current = {
								mimeType: recorder.mimeType,
								audioBitsPerSecond: AUDIO_BITRATE_VOICE,
								timesliceMs: RECORDER_TIMESLICE_MS,
							};
							resetMicFallbackTimingDiagnostics();
							micFallbackRecorderStartedAt.current = performance.now();
							recorder.ondataavailable = appendMicFallbackChunk;
							micFallbackStartDelayMs.current = Math.max(
								0,
								Date.now() - mainStartedAt,
							);
							recorder.start(RECORDER_TIMESLICE_MS);
							micFallbackRecorder.current = recorder;
						} catch (micError) {
							micFallbackStartDelayMs.current = null;
							micFallbackTrackSettings.current = null;
							micFallbackRequestedConstraints.current = null;
							micFallbackAudioInputDevices.current = null;
							micFallbackRecorderMetadata.current = null;
							resetMicFallbackTimingDiagnostics();
							console.warn("Browser microphone fallback failed:", micError);
							const permissionDenied =
								micError instanceof DOMException &&
								(micError.name === "NotAllowedError" ||
									micError.name === "SecurityError");
							toast.error(
								permissionDenied
									? "Microphone permission denied. Recording will continue without microphone audio."
									: `${getErrorMessage(micError)}. Recording will continue without microphone audio.`,
								{ id: MICROPHONE_FALLBACK_ERROR_TOAST_ID, duration: 10000 },
							);
						}
					}

					setRecording(true);
					try {
						await window.electronAPI?.setRecordingState(true);
					} catch (stateError) {
						console.warn(
							"Failed to notify main process that native recording started:",
							stateError,
						);
					}

					return;
				}
			}

			const browserCursorPolicy = resolveBrowserCaptureCursorPolicy({
				nativeWindowsCaptureStartFailed,
			});
			hideEditorOverlayCursorByDefault.current =
				browserCursorPolicy.hideEditorOverlayCursorByDefault;

			const wantsAudioCapture = microphoneEnabled || systemAudioEnabled;
			const browserCaptureSource = await resolveBrowserCaptureSource(selectedSource);

			if (
				browserCaptureSource?.id?.startsWith("screen:fallback:") ||
				browserCaptureSource?.id?.startsWith("window:fallback:")
			) {
				throw new Error(
					"Selected display is not available for browser capture on this system.",
				);
			}

			if (browserCursorPolicy.hideOsCursorBeforeRecording) {
				try {
					const hideCursorResult = await window.electronAPI.hideOsCursor?.();
					if (hideCursorResult && !hideCursorResult.success) {
						console.warn(
							"Could not hide OS cursor before recording.",
							hideCursorResult,
						);
					}
				} catch {
					console.warn("Could not hide OS cursor before recording.");
				}
			}

			let videoTrack: MediaStreamTrack | undefined;
			let systemAudioIncluded = false;
			const mediaDevices = navigator.mediaDevices as DesktopCaptureMediaDevices;
			const useLinuxPortal = selectedSource.id === "screen:linux-portal";
			const qualityDims = QUALITY_DIMENSIONS[recordingQuality] ?? QUALITY_DIMENSIONS["4k"];
			const maxCaptureWidth = qualityDims.width;
			const maxCaptureHeight = qualityDims.height;
			// Compute the physical pixel dimensions of the display so Chromium captures
			// at native Retina resolution rather than falling back to logical (CSS) pixels.
			const physicalWidth = Math.round(window.screen.width * window.devicePixelRatio);
			const physicalHeight = Math.round(window.screen.height * window.devicePixelRatio);
			const captureWidth = Math.min(Math.max(physicalWidth, DEFAULT_WIDTH), maxCaptureWidth);
			const captureHeight = Math.min(Math.max(physicalHeight, DEFAULT_HEIGHT), maxCaptureHeight);
			const browserScreenVideoConstraints = {
				mandatory: {
					chromeMediaSource: CHROME_MEDIA_SOURCE,
					chromeMediaSourceId: browserCaptureSource.id,
					minWidth: captureWidth,
					maxWidth: maxCaptureWidth,
					minHeight: captureHeight,
					maxHeight: maxCaptureHeight,
					maxFrameRate: TARGET_FRAME_RATE,
					minFrameRate: MIN_FRAME_RATE,
					googCaptureCursor: browserCursorPolicy.streamCursor === "always",
				},
				cursor: browserCursorPolicy.streamCursor,
			};

			if (wantsAudioCapture) {
				let screenMediaStream: MediaStream;
				const acquireLinuxPortalStream = (withAudio: boolean) =>
					mediaDevices.getDisplayMedia({
						audio: withAudio,
						video: {
							displaySurface: "monitor",
							width: { ideal: maxCaptureWidth, max: maxCaptureWidth },
							height: { ideal: maxCaptureHeight, max: maxCaptureHeight },
							frameRate: { ideal: TARGET_FRAME_RATE, max: TARGET_FRAME_RATE },
							cursor: browserCursorPolicy.streamCursor,
						},
						selfBrowserSurface: "exclude",
						surfaceSwitching: "exclude",
					});

				if (systemAudioEnabled) {
					try {
						screenMediaStream = useLinuxPortal
							? await acquireLinuxPortalStream(true)
							: await mediaDevices.getUserMedia({
									audio: {
										mandatory: {
											chromeMediaSource: CHROME_MEDIA_SOURCE,
											chromeMediaSourceId: browserCaptureSource.id,
										},
									},
									video: browserScreenVideoConstraints,
								});
					} catch (audioError) {
						console.warn(
							"System audio capture failed, falling back to video-only:",
							audioError,
						);
						alert(
							"System audio is not available for this source. Recording will continue without system audio.",
						);
						screenMediaStream = useLinuxPortal
							? await acquireLinuxPortalStream(false)
							: await mediaDevices.getUserMedia({
									audio: false,
									video: browserScreenVideoConstraints,
								});
					}
				} else {
					screenMediaStream = useLinuxPortal
						? await acquireLinuxPortalStream(false)
						: await mediaDevices.getUserMedia({
								audio: false,
								video: browserScreenVideoConstraints,
							});
				}

				screenStream.current = screenMediaStream;
				stream.current = new MediaStream();

				videoTrack = screenMediaStream.getVideoTracks()[0];
				if (!videoTrack) {
					throw new Error("Video track is not available.");
				}

				stream.current.addTrack(videoTrack);

				if (microphoneEnabled) {
					try {
						microphoneStream.current = await navigator.mediaDevices.getUserMedia(
							createProcessedMicrophoneConstraints(
								microphoneDeviceId,
								browserMicrophoneProfile.current,
							),
						);
					} catch (audioError) {
						console.warn("Failed to get microphone access:", audioError);
						alert(
							"Microphone access was denied. Recording will continue without microphone audio.",
						);
						setMicrophoneEnabled(false);
					}
				}

				const systemAudioTrack = screenMediaStream.getAudioTracks()[0];
				const micAudioTrack = microphoneStream.current?.getAudioTracks()[0];

				if (systemAudioTrack && micAudioTrack) {
					await new Promise((resolve) => setTimeout(resolve, 0));
					const context = new AudioContext({ sampleRate: 48000 });
					mixingContext.current = context;
					const systemSource = context.createMediaStreamSource(
						new MediaStream([systemAudioTrack]),
					);
					const micSource = context.createMediaStreamSource(
						new MediaStream([micAudioTrack]),
					);
					const micGain = context.createGain();
					micGain.gain.value = MIC_GAIN_BOOST;
					const destination = context.createMediaStreamDestination();

					systemSource.connect(destination);
					micSource.connect(micGain).connect(destination);

					const mixedTrack = destination.stream.getAudioTracks()[0];
					if (mixedTrack) {
						stream.current.addTrack(mixedTrack);
						systemAudioIncluded = true;
					}
				} else if (systemAudioTrack) {
					stream.current.addTrack(systemAudioTrack);
					systemAudioIncluded = true;
				} else if (micAudioTrack) {
					stream.current.addTrack(micAudioTrack);
				}
			} else {
				const mediaStream = useLinuxPortal
					? await mediaDevices.getDisplayMedia({
							audio: false,
							video: {
								displaySurface: selectedSource.id?.startsWith("window:")
									? "window"
									: "monitor",
								width: { ideal: maxCaptureWidth, max: maxCaptureWidth },
								height: { ideal: maxCaptureHeight, max: maxCaptureHeight },
								frameRate: { ideal: TARGET_FRAME_RATE, max: TARGET_FRAME_RATE },
								cursor: browserCursorPolicy.streamCursor,
							},
							selfBrowserSurface: "exclude",
							surfaceSwitching: "exclude",
						})
					: await mediaDevices.getUserMedia({
							audio: false,
							video: browserScreenVideoConstraints,
						});

				stream.current = mediaStream;
				videoTrack = mediaStream.getVideoTracks()[0];
			}

			if (!stream.current || !videoTrack) {
				throw new Error("Media stream is not available.");
			}

			try {
				await withTimeout(
					videoTrack.applyConstraints({
						frameRate: { ideal: TARGET_FRAME_RATE, max: TARGET_FRAME_RATE },
						width: { ideal: maxCaptureWidth, max: maxCaptureWidth },
						height: { ideal: maxCaptureHeight, max: maxCaptureHeight },
					} as MediaTrackConstraints),
					CONSTRAINTS_TIMEOUT_MS,
					"applyConstraints",
				);
			} catch (error) {
				console.warn(
					"Unable to lock resolution/fps constraints, using best available track settings.",
					error,
				);
			}

			let {
				width = DEFAULT_WIDTH,
				height = DEFAULT_HEIGHT,
				frameRate = TARGET_FRAME_RATE,
			} = videoTrack.getSettings();

			width = Math.floor(width / CODEC_ALIGNMENT) * CODEC_ALIGNMENT;
			height = Math.floor(height / CODEC_ALIGNMENT) * CODEC_ALIGNMENT;

			const videoBitsPerSecond = computeBitrate(width, height);
			const mimeType = selectMimeType();

			console.log(
				`Recording at ${width}x${height} @ ${frameRate ?? TARGET_FRAME_RATE}fps using ${mimeType ?? "browser default"} / ${Math.round(
					videoBitsPerSecond / BITS_PER_MEGABIT,
				)} Mbps`,
			);

			chunks.current = [];
			const hasAudio = stream.current.getAudioTracks().length > 0;
			const audioBitsPerSecond = hasAudio
				? systemAudioIncluded
					? AUDIO_BITRATE_SYSTEM
					: AUDIO_BITRATE_VOICE
				: undefined;
			const recorder = new MediaRecorder(
				stream.current,
				createBrowserRecordingOptions({
					audioBitsPerSecond,
					mimeType,
					videoBitsPerSecond,
				}),
			);

			mediaRecorder.current = recorder;
			recorder.ondataavailable = (event) => {
				if (event.data && event.data.size > 0) chunks.current.push(event.data);
			};
			recorder.onstop = async () => {
				cleanupCapturedMedia();
				if (chunks.current.length === 0) {
					setFinalizing(false);
					return;
				}

				const duration = getRecordingDurationMs(Date.now());
				const recordedChunks = chunks.current;
				const recordingBlobType = recorder.mimeType || mimeType;
				const buggyBlob = new Blob(
					recordedChunks,
					recordingBlobType ? { type: recordingBlobType } : undefined,
				);
				chunks.current = [];
				const timestamp = recordingSessionTimestamp.current ?? Date.now();
				const videoFileName = `${RECORDING_FILE_PREFIX}${timestamp}${getVideoExtensionForMimeType(recordingBlobType)}`;

				try {
					const videoBlob = isWebmMimeType(recordingBlobType)
						? await fixWebmDuration(buggyBlob, duration)
						: buggyBlob;
					const arrayBuffer = await videoBlob.arrayBuffer();
					const videoResult = await window.electronAPI.storeRecordedVideo(
						arrayBuffer,
						videoFileName,
					);
					if (!videoResult.success) {
						console.error("Failed to store video:", videoResult.message);
						await notifyRecordingFinalizationFailure(
							videoResult.message || "Failed to store the recording.",
						);
						return;
					}

					if (videoResult.path) {
						const finalVideoPath = videoResult.path;
						// 1. Launch editor immediately (Optimistic UI)
						await finalizeRecordingSession(finalVideoPath, null);

						// 2. Background webcam processing
						void (async () => {
							const webcamTracks = pendingWebcamTracksPromise.current
								? await pendingWebcamTracksPromise.current
								: resolvedWebcamTracks.current;

							try {
								if (webcamTracks.length > 0) {
									await window.electronAPI.setCurrentRecordingSession({
										videoPath: finalVideoPath,
										webcamPath: webcamTracks[0].path,
										timeOffsetMs: webcamTracks[0].timeOffsetMs,
										webcams: webcamTracks,
										hideOverlayCursorByDefault:
											hideEditorOverlayCursorByDefault.current,
									});
								}
							} finally {
								// After all background tasks are done (webcam),
								// we can safely close the HUD window to release hardware and resources.
								if (typeof window.electronAPI?.hudOverlayClose === "function") {
									console.log(
										"[useScreenRecorder:browser] All background tasks finished, closing HUD",
									);
									window.electronAPI.hudOverlayClose();
								}
							}
						})();
					} else {
						await notifyRecordingFinalizationFailure("Failed to save the recording.");
					}
				} catch (error) {
					console.error("Error saving recording:", error);
					const message = error instanceof Error ? error.message : String(error);
					await notifyRecordingFinalizationFailure(
						`Failed to finalize the recording. ${message}`,
					);
				}
			};
			recorder.onerror = () => {
				setRecording(false);
			};
			const mainStartedAt = Date.now();
			beginWebcamCapture();
			resetRecordingClock(mainStartedAt);
			applyWebcamTimeOffsets(mainStartedAt);
			recorder.start(RECORDER_TIMESLICE_MS);
			setRecording(true);
			try {
				await window.electronAPI?.setRecordingState(true);
			} catch (stateError) {
				console.warn("Failed to notify main process that recording started:", stateError);
			}
		} catch (error) {
			console.error("Failed to start recording:", error);
			alert(
				error instanceof Error
					? `Failed to start recording: ${error.message}`
					: "Failed to start recording",
			);
			setRecording(false);
			try {
				await window.electronAPI?.setRecordingState(false);
			} catch (stateError) {
				console.warn("Failed to reset main-process recording state:", stateError);
			} finally {
				cleanupCapturedMedia();
				await stopWebcamRecorder();
			}
		} finally {
			clearTimeout(masterTimeout);
			setHudSourceSelectionActive(false);
			startInFlight.current = false;
			setStarting(false);
		}
	};

	const pauseRecording = useCallback(() => {
		if (!recording || paused) return;
		if (nativeScreenRecording.current) {
			void (async () => {
				const result = await window.electronAPI.pauseNativeScreenRecording();
				if (!result.success) {
					console.error(
						"Failed to pause native screen recording:",
						result.error ?? result.message,
					);
					return;
				}

				for (const slot of webcamSlots.current) {
					if (slot.recorder?.state === "recording") {
						slot.recorder.pause();
					}
				}
				pauseMicFallbackRecorder();
				const boundaryMs = Date.now();
				markRecordingPaused(boundaryMs);
				setPaused(true);
				try {
					await window.electronAPI.pauseCursorCapture(boundaryMs);
				} catch (error) {
					console.warn("Failed to pause cursor capture:", error);
				}
			})();
			return;
		}
		if (mediaRecorder.current?.state === "recording") {
			mediaRecorder.current.pause();
			for (const slot of webcamSlots.current) {
				if (slot.recorder?.state === "recording") {
					slot.recorder.pause();
				}
			}
			void (async () => {
				const boundaryMs = Date.now();
				markRecordingPaused(boundaryMs);
				setPaused(true);
				try {
					await window.electronAPI.pauseCursorCapture(boundaryMs);
				} catch (error) {
					console.warn("Failed to pause cursor capture:", error);
				}
			})();
		}
	}, [markRecordingPaused, pauseMicFallbackRecorder, paused, recording]);

	const resumeRecording = useCallback(() => {
		if (!recording || !paused) return;
		if (nativeScreenRecording.current) {
			void (async () => {
				const result = await window.electronAPI.resumeNativeScreenRecording();
				if (!result.success) {
					console.error(
						"Failed to resume native screen recording:",
						result.error ?? result.message,
					);
					return;
				}

				for (const slot of webcamSlots.current) {
					if (slot.recorder?.state === "paused") {
						slot.recorder.resume();
					}
				}
				resumeMicFallbackRecorder();
				const boundaryMs = Date.now();
				markRecordingResumed(boundaryMs);
				setPaused(false);
				try {
					await window.electronAPI.resumeCursorCapture(boundaryMs);
				} catch (error) {
					console.warn("Failed to resume cursor capture:", error);
				}
			})();
			return;
		}
		if (mediaRecorder.current?.state === "paused") {
			mediaRecorder.current.resume();
			for (const slot of webcamSlots.current) {
				if (slot.recorder?.state === "paused") {
					slot.recorder.resume();
				}
			}
			void (async () => {
				const boundaryMs = Date.now();
				markRecordingResumed(boundaryMs);
				setPaused(false);
				try {
					await window.electronAPI.resumeCursorCapture(boundaryMs);
				} catch (error) {
					console.warn("Failed to resume cursor capture:", error);
				}
			})();
		}
	}, [markRecordingResumed, paused, recording, resumeMicFallbackRecorder]);

	const cancelRecording = useCallback(() => {
		if (!recording) return;
		setPaused(false);
		markRecordingResumed(Date.now());

		// Discard webcam recordings regardless of recording mode
		for (const slot of webcamSlots.current) {
			slot.chunks = [];
			if (slot.recorder && slot.recorder.state !== "inactive") {
				slot.recorder.stop();
			}
			slot.recorder = null;
			slot.startTime = null;
			slot.timeOffsetMs = 0;
			slot.stream?.getTracks().forEach((t) => t.stop());
			slot.stream = null;
		}
		webcamSlots.current = [];
		pendingWebcamTracksPromise.current = null;
		resolvedWebcamTracks.current = [];

		if (nativeScreenRecording.current) {
			nativeScreenRecording.current = false;
			nativeWindowsRecording.current = false;
			setRecording(false);
			window.electronAPI?.setRecordingState(false);
			void (async () => {
				try {
					const result = await window.electronAPI.stopNativeScreenRecording();
					if (result?.path) {
						await window.electronAPI.deleteRecordingFile(result.path);
					}
				} catch {
					// Best-effort cleanup
				}
			})();
			return;
		}

		if (mediaRecorder.current) {
			chunks.current = [];
			cleanupCapturedMedia();
			if (mediaRecorder.current.state !== "inactive") {
				mediaRecorder.current.stop();
			}
			setRecording(false);
			window.electronAPI?.setRecordingState(false);
		}
	}, [cleanupCapturedMedia, markRecordingResumed, recording]);

	const toggleRecording = async () => {
		if (starting || countdownActive || finalizing) {
			return;
		}

		if (recording) {
			stopRecording.current();
			return;
		}

		// Start recording with optional countdown
		if (countdownDelay > 0) {
			setCountdownActive(true);
			try {
				const result = await window.electronAPI.startCountdown(countdownDelay);
				if (!result.success || result.cancelled) {
					return;
				}
			} finally {
				setCountdownActive(false);
			}
		}

		startRecording();
	};

	return {
		recording,
		paused,
		finalizing,
		countdownActive,
		toggleRecording,
		pauseRecording,
		resumeRecording,
		cancelRecording,
		preparePermissions,
		isMacOS,
		microphoneEnabled,
		setMicrophoneEnabled: persistMicrophoneEnabled,
		microphoneDeviceId,
		setMicrophoneDeviceId: persistMicrophoneDeviceId,
		systemAudioEnabled,
		setSystemAudioEnabled: persistSystemAudioEnabled,
		webcamEnabled,
		setWebcamEnabled,
		webcamDeviceId,
		setWebcamDeviceId,
		webcamDeviceIds,
		setWebcamDeviceIds,
		countdownDelay,
		setCountdownDelay,
		recordingQuality,
		setRecordingQuality: persistRecordingQuality,
	};
}
