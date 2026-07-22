import type { Span } from "dnd-timeline";
import type { TimelineRegionSpan } from "../core/timelineTypes";

/** Pixel distance (at current zoom) within which timeline edges snap together. */
export const SNAP_THRESHOLD_PX = 8;

export type SnapMode = "move" | "resize-start" | "resize-end";

export interface SnapResult {
	span: Span;
	/** The target time (ms) an edge snapped to, or null when nothing snapped. */
	snappedTo: number | null;
}

export function collectSnapTargets(params: {
	allRegionSpans: TimelineRegionSpan[];
	activeItemId: string;
	totalMs: number;
	playheadMs?: number | null;
}): number[] {
	const { allRegionSpans, activeItemId, totalMs, playheadMs } = params;
	const targets = new Set<number>([0]);
	if (totalMs > 0) {
		targets.add(Math.round(totalMs));
	}
	if (playheadMs !== null && playheadMs !== undefined && Number.isFinite(playheadMs)) {
		targets.add(Math.round(playheadMs));
	}
	for (const region of allRegionSpans) {
		if (region.id === activeItemId) continue;
		targets.add(Math.round(region.start));
		targets.add(Math.round(region.end));
	}
	return [...targets];
}

export function applySnapToSpan(
	span: Span,
	mode: SnapMode,
	targetsMs: number[],
	thresholdMs: number,
): SnapResult {
	if (!(thresholdMs > 0) || targetsMs.length === 0) {
		return { span, snappedTo: null };
	}

	const duration = span.end - span.start;
	const candidates: Array<{ edge: "start" | "end"; value: number }> = [];
	if (mode === "move" || mode === "resize-start") {
		candidates.push({ edge: "start", value: span.start });
	}
	if (mode === "move" || mode === "resize-end") {
		candidates.push({ edge: "end", value: span.end });
	}

	let snap: { target: number; distance: number; edge: "start" | "end" } | null = null;
	for (const candidate of candidates) {
		for (const target of targetsMs) {
			const distance = Math.abs(candidate.value - target);
			if (distance <= thresholdMs && (!snap || distance < snap.distance)) {
				snap = { target, distance, edge: candidate.edge };
			}
		}
	}

	if (!snap) {
		return { span, snappedTo: null };
	}

	if (mode === "move") {
		const start = snap.edge === "start" ? snap.target : snap.target - duration;
		return { span: { start, end: start + duration }, snappedTo: snap.target };
	}

	const snapped: Span =
		mode === "resize-start"
			? { start: snap.target, end: span.end }
			: { start: span.start, end: snap.target };
	if (snapped.end - snapped.start <= 0) {
		return { span, snappedTo: null };
	}
	return { span: snapped, snappedTo: snap.target };
}
