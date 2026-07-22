import { describe, expect, it } from "vitest";
import { rippleRemoveRange, trimRegionsToRemovedRange } from "./regionEditing";

const region = (id: string, startMs: number, endMs: number) => ({ id, startMs, endMs });

describe("trimRegionsToRemovedRange", () => {
	it("keeps regions fully outside the removed range", () => {
		const regions = [region("a", 0, 1_000), region("b", 5_000, 6_000)];
		expect(trimRegionsToRemovedRange(regions, 2_000, 4_000)).toEqual(regions);
	});

	it("drops regions fully inside the removed range", () => {
		expect(trimRegionsToRemovedRange([region("a", 2_500, 3_500)], 2_000, 4_000)).toEqual([]);
	});

	it("clamps a region crossing the range start to the boundary", () => {
		expect(trimRegionsToRemovedRange([region("a", 1_000, 3_000)], 2_000, 4_000)).toEqual([
			region("a", 1_000, 2_000),
		]);
	});

	it("clamps a region crossing the range end to the boundary", () => {
		expect(trimRegionsToRemovedRange([region("a", 3_000, 5_000)], 2_000, 4_000)).toEqual([
			region("a", 4_000, 5_000),
		]);
	});

	it("keeps a region spanning the whole removed range", () => {
		expect(trimRegionsToRemovedRange([region("a", 1_000, 5_000)], 2_000, 4_000)).toEqual([
			region("a", 1_000, 5_000),
		]);
	});

	it("returns regions unchanged for an empty range", () => {
		const regions = [region("a", 0, 1_000)];
		expect(trimRegionsToRemovedRange(regions, 3_000, 3_000)).toEqual(regions);
	});
});

describe("rippleRemoveRange", () => {
	it("shifts regions after the cut left by the gap", () => {
		expect(rippleRemoveRange([region("a", 5_000, 6_000)], 2_000, 4_000)).toEqual([
			region("a", 3_000, 4_000),
		]);
	});

	it("keeps regions before the cut in place", () => {
		expect(rippleRemoveRange([region("a", 0, 1_500)], 2_000, 4_000)).toEqual([
			region("a", 0, 1_500),
		]);
	});

	it("drops regions fully inside the cut", () => {
		expect(rippleRemoveRange([region("a", 2_500, 3_500)], 2_000, 4_000)).toEqual([]);
	});

	it("shortens a region spanning the cut by the gap", () => {
		expect(rippleRemoveRange([region("a", 1_000, 5_000)], 2_000, 4_000)).toEqual([
			region("a", 1_000, 3_000),
		]);
	});

	it("clamps a region crossing the cut start", () => {
		expect(rippleRemoveRange([region("a", 1_000, 3_000)], 2_000, 4_000)).toEqual([
			region("a", 1_000, 2_000),
		]);
	});

	it("moves and clamps a region crossing the cut end", () => {
		expect(rippleRemoveRange([region("a", 3_000, 5_000)], 2_000, 4_000)).toEqual([
			region("a", 2_000, 3_000),
		]);
	});
});
