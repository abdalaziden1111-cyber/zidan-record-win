import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { RECORDING_SESSION_MANIFEST_SUFFIX } from "../constants";
import type {
	RecordingSessionData,
	RecordingSessionManifest,
	RecordingWebcamTrack,
	WebcamTrackManifestEntry,
} from "../types";
import { normalizeVideoSourcePath, parseJsonWithByteOrderMark } from "../utils";

function normalizeRecordingTimeOffsetMs(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

export function getRecordingSessionManifestPath(videoPath: string) {
	const extension = path.extname(videoPath);
	const baseName = path.basename(videoPath, extension);
	return path.join(path.dirname(videoPath), `${baseName}${RECORDING_SESSION_MANIFEST_SUFFIX}`);
}

export async function persistRecordingSessionManifest(session: RecordingSessionData): Promise<void> {
	const normalizedVideoPath = normalizeVideoSourcePath(session.videoPath);
	if (!normalizedVideoPath) {
		return;
	}

	const webcamTracks: RecordingWebcamTrack[] = [];
	for (const track of session.webcams ?? []) {
		const normalizedTrackPath = normalizeVideoSourcePath(track.path);
		if (normalizedTrackPath) {
			webcamTracks.push({ ...track, path: normalizedTrackPath });
		}
	}

	if (webcamTracks.length === 0) {
		const normalizedWebcamPath = normalizeVideoSourcePath(session.webcamPath ?? null);
		if (normalizedWebcamPath) {
			webcamTracks.push({
				path: normalizedWebcamPath,
				timeOffsetMs: normalizeRecordingTimeOffsetMs(session.timeOffsetMs),
			});
		}
	}

	const manifestPath = getRecordingSessionManifestPath(normalizedVideoPath);

	if (webcamTracks.length === 0) {
		await fs.rm(manifestPath, { force: true });
		return;
	}

	const manifest: RecordingSessionManifest = {
		version: 3,
		videoFileName: path.basename(normalizedVideoPath),
		webcamFileName: path.basename(webcamTracks[0].path),
		timeOffsetMs: normalizeRecordingTimeOffsetMs(webcamTracks[0].timeOffsetMs),
		webcams: webcamTracks.map((track) => ({
			fileName: path.basename(track.path),
			timeOffsetMs: normalizeRecordingTimeOffsetMs(track.timeOffsetMs),
			...(track.deviceLabel ? { deviceLabel: track.deviceLabel } : {}),
		})),
	};

	await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}

export async function resolveRecordingSessionManifest(
	videoPath?: string | null,
): Promise<RecordingSessionData | null> {
	const normalizedVideoPath = normalizeVideoSourcePath(videoPath);
	if (!normalizedVideoPath) {
		return null;
	}

	const manifestPath = getRecordingSessionManifestPath(normalizedVideoPath);

	try {
		const content = await fs.readFile(manifestPath, "utf-8");
		const parsed =
			parseJsonWithByteOrderMark<Partial<RecordingSessionManifest>>(content);
		if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) {
			return null;
		}

		const manifestWebcamTracks = await resolveManifestWebcamTracks(
			normalizedVideoPath,
			parsed.webcams,
		);
		if (manifestWebcamTracks) {
			return {
				videoPath: normalizedVideoPath,
				webcamPath: manifestWebcamTracks[0]?.path ?? null,
				timeOffsetMs: manifestWebcamTracks[0]?.timeOffsetMs ?? 0,
				webcams: manifestWebcamTracks,
			};
		}

		const webcamFileName =
			typeof parsed.webcamFileName === "string" && parsed.webcamFileName.trim()
				? parsed.webcamFileName.trim()
				: null;

		if (!webcamFileName) {
			return {
				videoPath: normalizedVideoPath,
				webcamPath: null,
				timeOffsetMs: normalizeRecordingTimeOffsetMs(parsed.timeOffsetMs),
			};
		}

		const webcamPath = path.join(path.dirname(normalizedVideoPath), webcamFileName);
		const webcamExists = await fs
			.access(webcamPath, fsConstants.F_OK)
			.then(() => true)
			.catch(() => false);

		const timeOffsetMs = normalizeRecordingTimeOffsetMs(parsed.timeOffsetMs);
		return {
			videoPath: normalizedVideoPath,
			webcamPath: webcamExists ? webcamPath : null,
			timeOffsetMs,
			...(webcamExists ? { webcams: [{ path: webcamPath, timeOffsetMs }] } : {}),
		};
	} catch {
		return null;
	}
}

async function resolveManifestWebcamTracks(
	videoPath: string,
	entries: WebcamTrackManifestEntry[] | undefined,
): Promise<RecordingWebcamTrack[] | null> {
	if (!Array.isArray(entries) || entries.length === 0) {
		return null;
	}

	const tracks: RecordingWebcamTrack[] = [];
	for (const entry of entries) {
		const fileName =
			entry && typeof entry.fileName === "string" && entry.fileName.trim()
				? entry.fileName.trim()
				: null;
		if (!fileName) {
			continue;
		}

		const trackPath = path.join(path.dirname(videoPath), fileName);
		const exists = await fs
			.access(trackPath, fsConstants.F_OK)
			.then(() => true)
			.catch(() => false);
		if (!exists) {
			continue;
		}

		tracks.push({
			path: trackPath,
			timeOffsetMs: normalizeRecordingTimeOffsetMs(entry.timeOffsetMs),
			...(typeof entry.deviceLabel === "string" && entry.deviceLabel.trim()
				? { deviceLabel: entry.deviceLabel.trim() }
				: {}),
		});
	}

	return tracks;
}

const LINKED_WEBCAM_SUFFIXES = ["-webcam", "-webcam2"];

export async function resolveLinkedWebcamPath(videoPath?: string | null): Promise<string | null> {
	const paths = await resolveLinkedWebcamPaths(videoPath);
	return paths[0] ?? null;
}

export async function resolveLinkedWebcamPaths(videoPath?: string | null): Promise<string[]> {
	const normalizedVideoPath = normalizeVideoSourcePath(videoPath);
	if (!normalizedVideoPath) {
		return [];
	}

	const extension = path.extname(normalizedVideoPath);
	const baseName = path.basename(normalizedVideoPath, extension);
	if (!baseName || LINKED_WEBCAM_SUFFIXES.some((suffix) => baseName.endsWith(suffix))) {
		return [];
	}

	const candidateExtensions = Array.from(
		new Set([extension, ".webm", ".mp4", ".mov", ".mkv", ".avi"].filter(Boolean)),
	);

	const foundPaths: string[] = [];
	for (const suffix of LINKED_WEBCAM_SUFFIXES) {
		for (const candidateExtension of candidateExtensions) {
			const candidatePath = path.join(
				path.dirname(normalizedVideoPath),
				`${baseName}${suffix}${candidateExtension}`,
			);

			try {
				await fs.access(candidatePath, fsConstants.F_OK);
				foundPaths.push(candidatePath);
				break;
			} catch {
				continue;
			}
		}
	}

	return foundPaths;
}

export async function resolveRecordingSession(
	videoPath?: string | null,
): Promise<RecordingSessionData | null> {
	const manifestSession = await resolveRecordingSessionManifest(videoPath);
	if (manifestSession) {
		return manifestSession;
	}

	const normalizedVideoPath = normalizeVideoSourcePath(videoPath);
	if (!normalizedVideoPath) {
		return null;
	}

	const linkedWebcamPaths = await resolveLinkedWebcamPaths(normalizedVideoPath);
	return {
		videoPath: normalizedVideoPath,
		webcamPath: linkedWebcamPaths[0] ?? null,
		...(linkedWebcamPaths.length > 0
			? { webcams: linkedWebcamPaths.map((p) => ({ path: p, timeOffsetMs: 0 })) }
			: {}),
	};
}


