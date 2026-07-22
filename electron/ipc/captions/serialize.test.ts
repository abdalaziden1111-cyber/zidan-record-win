import { describe, expect, it } from "vitest";
import {
	cuesToSrt,
	cuesToVtt,
	formatSrtTime,
	formatVttTime,
	type SerializableCue,
} from "./serialize";

const sampleCues: SerializableCue[] = [
	{ startMs: 0, endMs: 1500, text: "Hello world" },
	{ startMs: 1500, endMs: 3620, text: "مرحبا بالعالم" },
	{ startMs: 3600000 + 61000 + 5000 + 9, endMs: 3600000 + 61000 + 8000, text: "Late line" },
];

describe("caption timestamp formatting", () => {
	it("formats SRT timestamps with a comma separator", () => {
		expect(formatSrtTime(0)).toBe("00:00:00,000");
		expect(formatSrtTime(3661009)).toBe("01:01:01,009");
	});

	it("formats VTT timestamps with a dot separator", () => {
		expect(formatVttTime(0)).toBe("00:00:00.000");
		expect(formatVttTime(3661009)).toBe("01:01:01.009");
	});

	it("clamps negative or non-finite values to zero", () => {
		expect(formatSrtTime(-100)).toBe("00:00:00,000");
		expect(formatVttTime(Number.NaN)).toBe("00:00:00.000");
	});
});

describe("cuesToSrt", () => {
	it("produces sequentially numbered blocks separated by a blank line", () => {
		const srt = cuesToSrt(sampleCues);
		const blocks = srt.split("\n\n");
		expect(blocks).toHaveLength(3);
		expect(blocks[0]).toBe("1\n00:00:00,000 --> 00:00:01,500\nHello world");
		expect(blocks[1]).toContain("2\n00:00:01,500 --> 00:00:03,620\nمرحبا بالعالم");
	});
});

describe("cuesToVtt", () => {
	it("prefixes the WEBVTT header and uses dot-separated timestamps", () => {
		const vtt = cuesToVtt(sampleCues);
		expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
		expect(vtt).toContain("00:00:00.000 --> 00:00:01.500\nHello world");
		expect(vtt.endsWith("\n")).toBe(true);
	});

	it("returns a header-only file when there are no cues", () => {
		expect(cuesToVtt([])).toBe("WEBVTT\n");
	});
});

describe("cue normalization", () => {
	it("drops empty cues and guarantees end > start", () => {
		const srt = cuesToSrt([
			{ startMs: 500, endMs: 500, text: "zero-length" },
			{ startMs: 100, endMs: 200, text: "   " },
		]);
		// The whitespace-only cue is dropped; the zero-length cue is kept with end bumped by 1ms.
		expect(srt).toBe("1\n00:00:00,500 --> 00:00:00,501\nzero-length");
	});

	it("trims surrounding whitespace from cue text", () => {
		const vtt = cuesToVtt([{ startMs: 0, endMs: 1000, text: "  spaced  " }]);
		expect(vtt).toContain("\nspaced");
	});
});
