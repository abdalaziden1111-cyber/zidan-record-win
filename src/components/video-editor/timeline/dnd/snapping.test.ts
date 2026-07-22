import { describe, expect, it } from "vitest";
import { applySnapToSpan, collectSnapTargets } from "./snapping";

describe("collectSnapTargets", () => {
	it("gathers edges from all rows plus playhead and timeline bounds", () => {
		const targets = collectSnapTargets({
			allRegionSpans: [
				{ id: "a", start: 0, end: 1000, rowId: "row-clip" },
				{ id: "b", start: 1500, end: 2500, rowId: "row-clip" },
				{ id: "z", start: 200, end: 700, rowId: "row-zoom" },
			],
			activeItemId: "b",
			totalMs: 5000,
			playheadMs: 3300,
		});
		expect(targets).toContain(0);
		expect(targets).toContain(5000);
		expect(targets).toContain(3300);
		expect(targets).toContain(1000);
		expect(targets).toContain(200);
		expect(targets).toContain(700);
		expect(targets).not.toContain(1500);
		expect(targets).not.toContain(2500);
	});

	it("skips a missing playhead", () => {
		const targets = collectSnapTargets({
			allRegionSpans: [],
			activeItemId: "x",
			totalMs: 0,
			playheadMs: null,
		});
		expect(targets).toEqual([0]);
	});
});

describe("applySnapToSpan", () => {
	const targets = [0, 1000, 2500, 5000];

	it("snaps a moved span's start to the nearest target within threshold", () => {
		const result = applySnapToSpan({ start: 1040, end: 1840 }, "move", targets, 80);
		expect(result.span).toEqual({ start: 1000, end: 1800 });
		expect(result.snappedTo).toBe(1000);
	});

	it("snaps a moved span's end when it is the closer edge", () => {
		const result = applySnapToSpan({ start: 1650, end: 2450 }, "move", targets, 80);
		expect(result.span).toEqual({ start: 1700, end: 2500 });
		expect(result.snappedTo).toBe(2500);
	});

	it("preserves duration when snapping a move", () => {
		const result = applySnapToSpan({ start: 940, end: 2340 }, "move", targets, 80);
		expect(result.span.end - result.span.start).toBe(1400);
	});

	it("does not snap outside the threshold", () => {
		const result = applySnapToSpan({ start: 1200, end: 2000 }, "move", targets, 80);
		expect(result.span).toEqual({ start: 1200, end: 2000 });
		expect(result.snappedTo).toBeNull();
	});

	it("snaps only the resized edge for resize modes", () => {
		const start = applySnapToSpan({ start: 1030, end: 2000 }, "resize-start", targets, 80);
		expect(start.span).toEqual({ start: 1000, end: 2000 });

		const end = applySnapToSpan({ start: 1200, end: 2460 }, "resize-end", targets, 80);
		expect(end.span).toEqual({ start: 1200, end: 2500 });
	});

	it("refuses a resize snap that would collapse the span", () => {
		const result = applySnapToSpan({ start: 990, end: 1010 }, "resize-end", [1000, 990], 80);
		// Closest target for the end edge collapses the span to zero — keep original.
		const collapsed = applySnapToSpan({ start: 1000, end: 1010 }, "resize-end", [1000], 80);
		expect(collapsed.span).toEqual({ start: 1000, end: 1010 });
		expect(collapsed.snappedTo).toBeNull();
		expect(result.span.end - result.span.start).toBeGreaterThan(0);
	});

	it("returns the original span when threshold or targets are empty", () => {
		expect(applySnapToSpan({ start: 5, end: 10 }, "move", [], 80).snappedTo).toBeNull();
		expect(applySnapToSpan({ start: 5, end: 10 }, "move", [0], 0).snappedTo).toBeNull();
	});
});
