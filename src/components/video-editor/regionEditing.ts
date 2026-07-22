/**
 * Shared edits for effect regions (zoom / annotation / speed / audio) when a
 * range of the timeline is cut. Regions are timeline-coordinate spans; these
 * helpers keep the parts of a region that survive the cut instead of dropping
 * partially-overlapping regions wholesale.
 */

interface EditableRegion {
	startMs: number;
	endMs: number;
}

/**
 * Remove [startMs, endMs] from the timeline WITHOUT closing the gap.
 * Partially-overlapping regions are clamped to the boundary they cross,
 * regions fully inside are dropped, and regions spanning the whole range are
 * kept (they still have visible parts on both sides of the gap).
 */
export function trimRegionsToRemovedRange<T extends EditableRegion>(
	regions: T[],
	startMs: number,
	endMs: number,
): T[] {
	if (endMs <= startMs) {
		return regions;
	}

	return regions.flatMap((region) => {
		const overlaps = region.startMs < endMs && region.endMs > startMs;
		if (!overlaps) {
			return [region];
		}
		const spansWholeRange = region.startMs < startMs && region.endMs > endMs;
		if (spansWholeRange) {
			return [region];
		}
		const fullyInside = region.startMs >= startMs && region.endMs <= endMs;
		if (fullyInside) {
			return [];
		}
		if (region.startMs < startMs) {
			return [{ ...region, endMs: startMs }];
		}
		return [{ ...region, startMs: endMs }];
	});
}

/**
 * Remove [startMs, endMs] from the timeline AND close the gap (ripple).
 * Every timeline instant maps through: before the cut unchanged, after the
 * cut shifted left by the gap, inside the cut collapsed onto its start.
 * Regions that collapse to zero length disappear.
 */
export function rippleRemoveRange<T extends EditableRegion>(
	regions: T[],
	startMs: number,
	endMs: number,
): T[] {
	const gapMs = endMs - startMs;
	if (gapMs <= 0) {
		return regions;
	}

	const mapTime = (timeMs: number) => {
		if (timeMs <= startMs) return timeMs;
		if (timeMs >= endMs) return timeMs - gapMs;
		return startMs;
	};

	return regions.flatMap((region) => {
		const nextStartMs = mapTime(region.startMs);
		const nextEndMs = mapTime(region.endMs);
		if (nextEndMs - nextStartMs <= 0) {
			return [];
		}
		if (nextStartMs === region.startMs && nextEndMs === region.endMs) {
			return [region];
		}
		return [{ ...region, startMs: nextStartMs, endMs: nextEndMs }];
	});
}
