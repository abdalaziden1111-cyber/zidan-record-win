import { describe, expect, it } from "vitest";
import { deriveNextId } from "./projectPersistence";

import {
	type ClipRegion,
	clipsToTrims,
	extendAutoFullTrackClip,
	findClipAtTimelineTime,
	getClipSourceEndMs,
	getClipSourceStartMs,
	getTimelineDurationMs,
	mapSourceTimeToTimelineTime,
	mapTimelineTimeToSourceTime,
	trimsToClips,
} from "./types";

describe("extendAutoFullTrackClip", () => {
	it("extends the default full-track clip when metadata duration grows", () => {
		expect(
			extendAutoFullTrackClip(
				[{ id: "clip-1", startMs: 0, endMs: 5_000, speed: 1 }],
				"clip-1",
				5_000,
				8_000,
			),
		).toEqual([{ id: "clip-1", startMs: 0, endMs: 8_000, speed: 1 }]);
	});

	it("does not change a clip that no longer matches the auto-created shape", () => {
		expect(
			extendAutoFullTrackClip(
				[{ id: "clip-1", startMs: 0, endMs: 4_000, speed: 1.5 }],
				"clip-1",
				5_000,
				8_000,
			),
		).toBeNull();
	});

	it("does not change multi-clip timelines", () => {
		expect(
			extendAutoFullTrackClip(
				[
					{ id: "clip-1", startMs: 0, endMs: 3_000, speed: 1 },
					{ id: "clip-2", startMs: 4_000, endMs: 8_000, speed: 1 },
				],
				"clip-1",
				8_000,
				10_000,
			),
		).toBeNull();
	});

	it("does not change clips when the duration does not grow", () => {
		expect(
			extendAutoFullTrackClip(
				[{ id: "clip-1", startMs: 0, endMs: 8_000, speed: 1 }],
				"clip-1",
				8_000,
				8_000,
			),
		).toBeNull();
	});

	it("does not change clips when the auto-created clip id is missing", () => {
		expect(
			extendAutoFullTrackClip(
				[{ id: "clip-1", startMs: 0, endMs: 5_000, speed: 1 }],
				null,
				5_000,
				8_000,
			),
		).toBeNull();
	});

	it("does not change clips when the previous auto-created end time is missing", () => {
		expect(
			extendAutoFullTrackClip(
				[{ id: "clip-1", startMs: 0, endMs: 5_000, speed: 1 }],
				"clip-1",
				null,
				8_000,
			),
		).toBeNull();
	});

	it("does not change clips when the reported duration shrinks", () => {
		expect(
			extendAutoFullTrackClip(
				[{ id: "clip-1", startMs: 0, endMs: 8_000, speed: 1 }],
				"clip-1",
				8_000,
				7_000,
			),
		).toBeNull();
	});

	it("does not change clips when the tracked clip id no longer matches", () => {
		expect(
			extendAutoFullTrackClip(
				[{ id: "clip-1", startMs: 0, endMs: 5_000, speed: 1 }],
				"clip-2",
				5_000,
				8_000,
			),
		).toBeNull();
	});

	it("does not change clips when the clip no longer starts at zero", () => {
		expect(
			extendAutoFullTrackClip(
				[{ id: "clip-1", startMs: 250, endMs: 5_000, speed: 1 }],
				"clip-1",
				5_000,
				8_000,
			),
		).toBeNull();
	});
});

describe("clip timeline mapping", () => {
	const clips = [
		{ id: "clip-1", startMs: 0, endMs: 4_000, speed: 1 },
		{ id: "clip-2", startMs: 6_000, endMs: 8_000, speed: 2 },
	];

	it("maps kept timeline time into source time", () => {
		expect(mapTimelineTimeToSourceTime(1_500, clips)).toBe(1_500);
		expect(mapTimelineTimeToSourceTime(7_000, clips)).toBe(8_000);
	});

	it("snaps timeline gaps to the nearest clip edge", () => {
		expect(mapTimelineTimeToSourceTime(4_300, clips)).toBe(4_000);
		expect(mapTimelineTimeToSourceTime(5_700, clips)).toBe(6_000);
	});

	it("maps kept source time back into timeline time", () => {
		expect(mapSourceTimeToTimelineTime(1_500, clips)).toBe(1_500);
		expect(mapSourceTimeToTimelineTime(8_000, clips)).toBe(7_000);
	});

	it("snaps removed source gaps to the nearest kept boundary", () => {
		expect(mapSourceTimeToTimelineTime(4_200, clips)).toBe(4_000);
		expect(mapSourceTimeToTimelineTime(5_900, clips)).toBe(6_000);
	});

	it("finds clips only inside visible kept spans", () => {
		expect(findClipAtTimelineTime(500, clips)?.id).toBe("clip-1");
		expect(findClipAtTimelineTime(5_000, clips)).toBeNull();
	});

	it("derives the next clip id after converting trim gaps into clip ids", () => {
		const clipsFromTrims = trimsToClips(
			[
				{ id: "trim-gap-1", startMs: 1_000, endMs: 2_000 },
				{ id: "trim-gap-2", startMs: 4_000, endMs: 5_000 },
			],
			6_000,
		);

		expect(clipsFromTrims.map((clip) => clip.id)).toEqual(["clip-1", "clip-2", "clip-3"]);
		expect(
			deriveNextId(
				"clip",
				clipsFromTrims.map((clip) => clip.id),
			),
		).toBe(4);
	});
});

describe("decoupled source coordinates (sourceStartMs)", () => {
	it("falls back to startMs for legacy clips without sourceStartMs", () => {
		const legacy: ClipRegion = { id: "clip-1", startMs: 2_000, endMs: 5_000, speed: 1 };
		expect(getClipSourceStartMs(legacy)).toBe(2_000);
		expect(getClipSourceEndMs(legacy)).toBe(5_000);
	});

	it("keeps the cut when a clip is dragged next to its neighbour (user scenario)", () => {
		// 60s video: split at 10s and 12s, delete the middle, then drag
		// [12s..60s] left so it butts against [0..10s].
		const clips: ClipRegion[] = [
			{ id: "clip-1", startMs: 0, endMs: 10_000, sourceStartMs: 0, speed: 1 },
			{ id: "clip-2", startMs: 10_000, endMs: 58_000, sourceStartMs: 12_000, speed: 1 },
		];

		// The removed footage 10s–12s must stay removed.
		expect(clipsToTrims(clips, 60_000)).toEqual([
			{ id: "trim-gap-1", startMs: 10_000, endMs: 12_000 },
		]);

		// Just past the join, the timeline shows source 12s+ (not deleted footage).
		// Exactly at the shared boundary the mapping keeps the earlier clip's end;
		// playback then hops the trim gap via the seek handlers.
		expect(mapTimelineTimeToSourceTime(10_001, clips)).toBe(12_001);
		expect(mapTimelineTimeToSourceTime(11_000, clips)).toBe(13_000);
		expect(mapSourceTimeToTimelineTime(12_000, clips)).toBe(10_000);
		expect(mapSourceTimeToTimelineTime(60_000, clips)).toBe(58_000);
	});

	it("keeps the cut after a ripple delete shifts later clips", () => {
		// Same edit via ripple delete: later clip shifts left on the timeline
		// while its footage window is pinned by sourceStartMs.
		const clips: ClipRegion[] = [
			{ id: "clip-1", startMs: 0, endMs: 10_000, sourceStartMs: 0, speed: 1 },
			{ id: "clip-3", startMs: 10_000, endMs: 58_000, sourceStartMs: 12_000, speed: 1 },
		];
		expect(clipsToTrims(clips, 60_000)).toEqual([
			{ id: "trim-gap-1", startMs: 10_000, endMs: 12_000 },
		]);
	});

	it("maps through moved clips with non-unit speed", () => {
		// Clip shows source 12s..20s at 2x → 4s on the timeline, placed at 10s.
		const clips: ClipRegion[] = [
			{ id: "clip-1", startMs: 10_000, endMs: 14_000, sourceStartMs: 12_000, speed: 2 },
		];
		expect(getClipSourceEndMs(clips[0])).toBe(20_000);
		expect(mapTimelineTimeToSourceTime(11_000, clips)).toBe(14_000);
		expect(mapSourceTimeToTimelineTime(16_000, clips)).toBe(12_000);
	});

	it("clamps gap lookups to the mapped counterpart of the nearest boundary", () => {
		const clips: ClipRegion[] = [
			{ id: "clip-1", startMs: 0, endMs: 10_000, sourceStartMs: 0, speed: 1 },
			{ id: "clip-2", startMs: 10_000, endMs: 58_000, sourceStartMs: 12_000, speed: 1 },
		];
		// Source 11s sits in the removed gap → nearest kept boundary maps to timeline 10s.
		expect(mapSourceTimeToTimelineTime(11_100, clips)).toBe(10_000);
	});

	it("emits sourceStartMs when converting legacy trims into clips", () => {
		const clips = trimsToClips([{ id: "trim-gap-1", startMs: 1_000, endMs: 2_000 }], 3_000);
		expect(clips).toEqual([
			{ id: "clip-1", startMs: 0, endMs: 1_000, sourceStartMs: 0, speed: 1 },
			{ id: "clip-2", startMs: 2_000, endMs: 3_000, sourceStartMs: 2_000, speed: 1 },
		]);
	});
});

describe("getTimelineDurationMs", () => {
	it("extends the timeline when a slow clip becomes longer than the source duration", () => {
		expect(
			getTimelineDurationMs(
				[{ id: "clip-1", startMs: 0, endMs: 20_000, speed: 0.5 }],
				10_000,
			),
		).toBe(20_000);
	});

	it("shrinks the timeline to the edited content when clips are shorter than the source", () => {
		expect(
			getTimelineDurationMs([{ id: "clip-1", startMs: 0, endMs: 5_000, speed: 2 }], 10_000),
		).toBe(5_000);
	});

	it("shrinks the timeline after cutting a middle segment and closing the gap", () => {
		expect(
			getTimelineDurationMs(
				[
					{ id: "clip-1", startMs: 0, endMs: 10_000, sourceStartMs: 0, speed: 1 },
					{
						id: "clip-2",
						startMs: 10_000,
						endMs: 18_000,
						sourceStartMs: 12_000,
						speed: 1,
					},
				],
				20_000,
			),
		).toBe(18_000);
	});

	it("keeps regions that outlive the clips reachable", () => {
		expect(
			getTimelineDurationMs(
				[{ id: "clip-1", startMs: 0, endMs: 5_000, sourceStartMs: 0, speed: 1 }],
				10_000,
				[7_500],
			),
		).toBe(7_500);
	});

	it("falls back to the source duration when no clips exist", () => {
		expect(getTimelineDurationMs([], 10_000)).toBe(10_000);
	});
});
