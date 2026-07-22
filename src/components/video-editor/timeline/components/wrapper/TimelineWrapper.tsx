import type {
	DragEndEvent,
	DragMoveEvent,
	DragStartEvent,
	Range,
	ResizeEndEvent,
	ResizeMoveEvent,
	Span,
} from "dnd-timeline";
import { TimelineContext } from "dnd-timeline";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { TimelineRegionSpan } from "../../core/timelineTypes";
import { clampRange, resolveDragEnd, resolveResizeEnd } from "../../dnd/engine";
import {
	applySnapToSpan,
	collectSnapTargets,
	SNAP_THRESHOLD_PX,
	type SnapMode,
} from "../../dnd/snapping";

interface TimelineWrapperProps {
	children: ReactNode;
	range: Range;
	videoDuration: number;
	hasOverlap: (newSpan: Span, excludeId?: string, rowId?: string) => boolean;
	onRangeChange: Dispatch<SetStateAction<Range>>;
	minItemDurationMs: number;
	minVisibleRangeMs: number;
	gridSizeMs?: number;
	onItemSpanChange: (id: string, span: Span, rowId?: string) => void;
	resolveTargetRowId?: (id: string, proposedRowId: string) => string;
	allRegionSpans?: TimelineRegionSpan[];
	onLiveSpanPreviewChange?: (id: string, span: Span | null) => void;
	/** Playhead position (timeline ms) used as an extra snap target. */
	playheadMs?: number;
}

export default function TimelineWrapper({
	children,
	range,
	videoDuration,
	hasOverlap,
	onRangeChange,
	minItemDurationMs,
	minVisibleRangeMs,
	gridSizeMs: _gridSizeMs,
	onItemSpanChange,
	resolveTargetRowId,
	allRegionSpans = [],
	onLiveSpanPreviewChange,
	playheadMs,
}: TimelineWrapperProps) {
	const totalMs = Math.max(0, Math.round(videoDuration * 1000));
	const containerRef = useRef<HTMLDivElement>(null);

	// Hold Alt/Option while dragging to temporarily bypass snapping.
	const snapBypassRef = useRef(false);
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Alt") snapBypassRef.current = true;
		};
		const handleKeyUp = (event: KeyboardEvent) => {
			if (event.key === "Alt") snapBypassRef.current = false;
		};
		window.addEventListener("keydown", handleKeyDown);
		window.addEventListener("keyup", handleKeyUp);
		window.addEventListener("blur", handleKeyUp as unknown as () => void);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("keyup", handleKeyUp);
			window.removeEventListener("blur", handleKeyUp as unknown as () => void);
		};
	}, []);

	const applySnap = useCallback(
		(span: Span, mode: SnapMode, activeItemId: string): Span => {
			if (snapBypassRef.current) return span;
			const containerWidth = containerRef.current?.clientWidth ?? 0;
			const visibleMs = Math.max(0, range.end - range.start);
			if (containerWidth <= 0 || visibleMs <= 0) return span;
			const thresholdMs = (visibleMs / containerWidth) * SNAP_THRESHOLD_PX;
			const targets = collectSnapTargets({
				allRegionSpans,
				activeItemId,
				totalMs,
				playheadMs,
			});
			return applySnapToSpan(span, mode, targets, thresholdMs).span;
		},
		[allRegionSpans, playheadMs, range.end, range.start, totalMs],
	);

	const resolveResizeMode = useCallback(
		(activeItemId: string, updatedSpan: Span): SnapMode => {
			const activeItem = allRegionSpans.find((region) => region.id === activeItemId);
			if (activeItem && Math.abs(updatedSpan.start - activeItem.start) < 1) {
				return "resize-end";
			}
			return activeItem ? "resize-start" : "resize-end";
		},
		[allRegionSpans],
	);

	const onResizeEnd = useCallback(
		(event: ResizeEndEvent) => {
			const updatedSpan = event.active.data.current.getSpanFromResizeEvent?.(event);
			if (!updatedSpan) return;

			const activeItemId = event.active.id as string;
			const snappedSpan = applySnap(
				updatedSpan,
				resolveResizeMode(activeItemId, updatedSpan),
				activeItemId,
			);
			const resolvedSpan = resolveResizeEnd(activeItemId, snappedSpan, {
				totalMs,
				minItemDurationMs,
				allRegionSpans,
				hasOverlap,
			});
			if (!resolvedSpan) return;
			onItemSpanChange(activeItemId, resolvedSpan);
		},
		[
			allRegionSpans,
			applySnap,
			hasOverlap,
			minItemDurationMs,
			onItemSpanChange,
			resolveResizeMode,
			totalMs,
		],
	);

	const onDragEnd = useCallback(
		(event: DragEndEvent) => {
			const proposedRowId = event.over?.id as string;
			const updatedSpan = event.active.data.current.getSpanFromDragEvent?.(event);
			if (!updatedSpan || !proposedRowId) return;

			const activeItemId = event.active.id as string;
			const snappedSpan = applySnap(updatedSpan, "move", activeItemId);
			const resolved = resolveDragEnd(
				activeItemId,
				snappedSpan,
				proposedRowId,
				{
					allRegionSpans,
					totalMs,
					minItemDurationMs,
					hasOverlap,
				},
				resolveTargetRowId,
			);
			if (!resolved) return;
			onItemSpanChange(activeItemId, resolved.span, resolved.rowId);
		},
		[
			allRegionSpans,
			applySnap,
			hasOverlap,
			minItemDurationMs,
			onItemSpanChange,
			resolveTargetRowId,
			totalMs,
		],
	);

	// Drag/resize tooltip (direct DOM updates, no re-renders)
	const tooltipRef = useRef<HTMLDivElement>(null);

	const formatTooltipMs = useCallback((ms: number) => {
		const s = ms / 1000;
		const min = Math.floor(s / 60);
		const sec = s % 60;
		return min > 0 ? `${min}:${sec.toFixed(1).padStart(4, "0")}` : `${sec.toFixed(1)}s`;
	}, []);

	const showTooltip = useCallback(
		(span: { start: number; end: number } | null, screenX?: number) => {
			const el = tooltipRef.current;
			if (!el) return;
			if (!span) {
				el.style.opacity = "0";
				return;
			}
			el.textContent = `${formatTooltipMs(span.start)} – ${formatTooltipMs(span.end)}`;
			el.style.opacity = "1";
			if (screenX !== undefined) {
				const parent = el.parentElement;
				if (parent) {
					const rect = parent.getBoundingClientRect();
					const x = Math.max(0, Math.min(screenX - rect.left, rect.width - 100));
					el.style.left = `${x}px`;
				}
			}
		},
		[formatTooltipMs],
	);

	const resolveDragPreviewSpan = useCallback(
		(event: DragMoveEvent, span: Span): Span | null => {
			const proposedRowId = event.over?.id as string | undefined;
			if (!proposedRowId) return span;

			const activeItemId = event.active.id as string;
			const resolved = resolveDragEnd(
				activeItemId,
				applySnap(span, "move", activeItemId),
				proposedRowId,
				{
					allRegionSpans,
					totalMs,
					minItemDurationMs,
					hasOverlap,
				},
				resolveTargetRowId,
			);

			return resolved?.span ?? null;
		},
		[allRegionSpans, applySnap, hasOverlap, minItemDurationMs, resolveTargetRowId, totalMs],
	);

	const onDragStart = useCallback(
		(event: DragStartEvent) => {
			const span = event.active.data.current.getSpanFromDragEvent?.(event);
			if (span) showTooltip(span);
		},
		[showTooltip],
	);

	const onDragMove = useCallback(
		(event: DragMoveEvent) => {
			const span = event.active.data.current.getSpanFromDragEvent?.(event);
			const previewSpan = span ? resolveDragPreviewSpan(event, span) : null;
			const screenX =
				event.activatorEvent && "clientX" in event.activatorEvent
					? (event.activatorEvent as PointerEvent).clientX + (event.delta?.x ?? 0)
					: undefined;
			if (previewSpan) {
				showTooltip(previewSpan, screenX);
			} else {
				showTooltip(null);
			}
			const moved = Math.hypot(event.delta?.x ?? 0, event.delta?.y ?? 0) > 0.01;
			if (moved) {
				onLiveSpanPreviewChange?.(event.active.id as string, previewSpan);
			}
		},
		[onLiveSpanPreviewChange, resolveDragPreviewSpan, showTooltip],
	);

	const onResizeMove = useCallback(
		(event: ResizeMoveEvent) => {
			const span = event.active.data.current.getSpanFromResizeEvent?.(event);
			const screenX =
				event.activatorEvent && "clientX" in event.activatorEvent
					? (event.activatorEvent as PointerEvent).clientX + (event.delta?.x ?? 0)
					: undefined;
			if (span) showTooltip(span, screenX);
			// dnd-timeline mutates the active item's DOM during resize; React preview
			// renders here can reset that inline width/edge position and make trims stutter.
		},
		[showTooltip],
	);

	const hideTooltip = useCallback(() => showTooltip(null), [showTooltip]);

	const onResizeEndWithTooltip = useCallback(
		(event: ResizeEndEvent) => {
			hideTooltip();
			onResizeEnd(event);
			onLiveSpanPreviewChange?.(event.active.id as string, null);
		},
		[hideTooltip, onLiveSpanPreviewChange, onResizeEnd],
	);

	const onDragEndWithTooltip = useCallback(
		(event: DragEndEvent) => {
			hideTooltip();
			onDragEnd(event);
			onLiveSpanPreviewChange?.(event.active.id as string, null);
		},
		[hideTooltip, onDragEnd, onLiveSpanPreviewChange],
	);

	const handleRangeChange = useCallback(
		(updater: (previous: Range) => Range) => {
			onRangeChange((prev) => {
				const normalized =
					totalMs > 0 ? clampRange(prev, { totalMs, minVisibleRangeMs }) : prev;
				const desired = updater(normalized);

				if (totalMs > 0) {
					return clampRange(desired, { totalMs, minVisibleRangeMs });
				}

				return desired;
			});
		},
		[minVisibleRangeMs, onRangeChange, totalMs],
	);

	return (
		<TimelineContext
			range={range}
			onRangeChanged={handleRangeChange}
			onResizeEnd={onResizeEndWithTooltip}
			onResizeMove={onResizeMove}
			onDragStart={onDragStart}
			onDragMove={onDragMove}
			onDragEnd={onDragEndWithTooltip}
			autoScroll={{
				enabled: true,
				threshold: { x: 0.08, y: 0.08 },
				acceleration: 3,
				interval: 16,
				layoutShiftCompensation: { x: false, y: false },
			}}
			resizeHandleWidth={28}
		>
			<div ref={containerRef} className="relative h-full min-h-0">
				{children}
				{/* Floating tooltip shown during drag/resize */}
				<div
					ref={tooltipRef}
					className="absolute top-1 pointer-events-none z-[60] px-1.5 py-0.5 rounded bg-editor-bg/90 text-[10px] text-foreground/90 font-medium tabular-nums whitespace-nowrap border border-foreground/10 shadow-lg"
					style={{ opacity: 0, transition: "opacity 0.1s" }}
				/>
			</div>
		</TimelineContext>
	);
}
