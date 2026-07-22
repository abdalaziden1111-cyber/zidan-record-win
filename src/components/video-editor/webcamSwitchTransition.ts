import type { CSSProperties } from "react";
import {
	DEFAULT_WEBCAM_SWITCH_TRANSITION,
	DEFAULT_WEBCAM_SWITCH_TRANSITION_MS,
	type WebcamOverlaySettings,
	type WebcamSwitchTransitionType,
} from "./types";

export const WEBCAM_SWITCH_TRANSITION_TYPES: WebcamSwitchTransitionType[] = [
	"none",
	"fade",
	"zoom",
	"slide",
	"flip",
];

export function resolveWebcamSwitchTransition(
	webcam:
		| Pick<WebcamOverlaySettings, "switchTransition" | "switchTransitionMs">
		| null
		| undefined,
): { type: WebcamSwitchTransitionType; durationMs: number } {
	return {
		type: webcam?.switchTransition ?? DEFAULT_WEBCAM_SWITCH_TRANSITION,
		durationMs: Math.max(0, webcam?.switchTransitionMs ?? DEFAULT_WEBCAM_SWITCH_TRANSITION_MS),
	};
}

function easeOutCubic(t: number): number {
	const clamped = Math.max(0, Math.min(1, t));
	return 1 - (1 - clamped) ** 3;
}

/**
 * Style for one stacked preview <video> in the webcam bubble. The active source
 * animates in while the previous one animates out; CSS transitions interpolate
 * automatically when the active flag flips.
 */
export function getWebcamSwitchPreviewStyle(
	type: WebcamSwitchTransitionType,
	durationMs: number,
	isActive: boolean,
): CSSProperties {
	if (type === "none" || durationMs <= 0) {
		return { visibility: isActive ? "visible" : "hidden" };
	}

	const base: CSSProperties = {
		opacity: isActive ? 1 : 0,
		zIndex: isActive ? 2 : 1,
	};

	switch (type) {
		case "zoom":
			return {
				...base,
				transform: isActive ? "scale(1)" : "scale(0.85)",
				transition: `opacity ${durationMs}ms ease-in-out, transform ${durationMs}ms ease-in-out`,
			};
		case "slide":
			return {
				...base,
				transform: isActive ? "translateX(0)" : "translateX(35%)",
				transition: `opacity ${durationMs}ms ease-in-out, transform ${durationMs}ms ease-in-out`,
			};
		case "flip":
			return {
				...base,
				transform: isActive
					? "perspective(800px) rotateY(0deg)"
					: "perspective(800px) rotateY(90deg)",
				transition: `opacity ${Math.round(durationMs * 0.6)}ms ease-in-out, transform ${durationMs}ms ease-in-out`,
			};
		default:
			return {
				...base,
				transition: `opacity ${durationMs}ms ease-in-out`,
			};
	}
}

export interface WebcamSwitchEntranceState {
	alpha: number;
	scale: number;
	scaleX: number;
	/** Horizontal offset as a fraction of the bubble size. */
	offsetXFactor: number;
}

const NEUTRAL_ENTRANCE: WebcamSwitchEntranceState = {
	alpha: 1,
	scale: 1,
	scaleX: 1,
	offsetXFactor: 0,
};

/**
 * Entrance animation of the incoming camera for the export renderer, which
 * draws a single webcam track at a time. `progress` is elapsed/duration in
 * [0, 1]; returns neutral values at 1 so the layout snaps back exactly.
 */
export function getWebcamSwitchEntranceState(
	type: WebcamSwitchTransitionType,
	progress: number,
): WebcamSwitchEntranceState {
	if (type === "none" || progress >= 1) {
		return NEUTRAL_ENTRANCE;
	}
	const eased = easeOutCubic(progress);
	switch (type) {
		case "fade":
			return { ...NEUTRAL_ENTRANCE, alpha: eased };
		case "zoom":
			return { ...NEUTRAL_ENTRANCE, alpha: eased, scale: 0.85 + 0.15 * eased };
		case "slide":
			return { ...NEUTRAL_ENTRANCE, alpha: eased, offsetXFactor: 0.35 * (1 - eased) };
		case "flip":
			return { ...NEUTRAL_ENTRANCE, alpha: Math.min(1, eased * 2), scaleX: eased };
		default:
			return NEUTRAL_ENTRANCE;
	}
}
