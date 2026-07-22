export type SerializableCue = {
	startMs: number;
	endMs: number;
	text: string;
};

function clampMs(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function splitMs(totalMs: number) {
	const ms = clampMs(totalMs);
	return {
		hours: Math.floor(ms / 3600000),
		minutes: Math.floor((ms % 3600000) / 60000),
		seconds: Math.floor((ms % 60000) / 1000),
		millis: ms % 1000,
	};
}

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/** SubRip (.srt) timestamp: HH:MM:SS,mmm */
export function formatSrtTime(totalMs: number): string {
	const { hours, minutes, seconds, millis } = splitMs(totalMs);
	return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

/** WebVTT (.vtt) timestamp: HH:MM:SS.mmm */
export function formatVttTime(totalMs: number): string {
	const { hours, minutes, seconds, millis } = splitMs(totalMs);
	return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

function normalizeCues(cues: SerializableCue[]): SerializableCue[] {
	return cues
		.filter((cue) => cue && typeof cue.text === "string" && cue.text.trim().length > 0)
		.map((cue) => {
			const startMs = clampMs(cue.startMs);
			const endMs = Math.max(startMs + 1, clampMs(cue.endMs));
			return { startMs, endMs, text: cue.text.trim() };
		});
}

export function cuesToSrt(cues: SerializableCue[]): string {
	return normalizeCues(cues)
		.map(
			(cue, index) =>
				`${index + 1}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\n${cue.text}`,
		)
		.join("\n\n");
}

export function cuesToVtt(cues: SerializableCue[]): string {
	const body = normalizeCues(cues)
		.map(
			(cue, index) =>
				`${index + 1}\n${formatVttTime(cue.startMs)} --> ${formatVttTime(cue.endMs)}\n${cue.text}`,
		)
		.join("\n\n");

	return body.length > 0 ? `WEBVTT\n\n${body}\n` : "WEBVTT\n";
}
