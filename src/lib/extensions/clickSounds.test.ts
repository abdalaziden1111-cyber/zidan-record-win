import { describe, expect, it } from "vitest";
import {
	buildClickSoundExportEvents,
	DEFAULT_CLICK_SOUND_INTERACTION_TYPES,
	type RegisteredClickSound,
} from "./clickSounds";

const sound = (overrides: Partial<RegisteredClickSound> = {}): RegisteredClickSound => ({
	url: "file:///ext/sounds/click.mp3",
	volume: 1,
	interactionTypes: [...DEFAULT_CLICK_SOUND_INTERACTION_TYPES],
	...overrides,
});

describe("buildClickSoundExportEvents", () => {
	it("produces one event per matching click, sorted by time", () => {
		const events = buildClickSoundExportEvents({
			telemetry: [
				{ timeMs: 5_000, interactionType: "click" },
				{ timeMs: 1_000, interactionType: "click" },
				{ timeMs: 3_000, interactionType: "double-click" },
			],
			clickSounds: [sound()],
			clickSoundVolume: 1,
		});
		expect(events.map((event) => event.sourceTimeMs)).toEqual([1_000, 3_000, 5_000]);
	});

	it("ignores move points and points without an interaction type", () => {
		const events = buildClickSoundExportEvents({
			telemetry: [
				{ timeMs: 100, interactionType: "move" },
				{ timeMs: 200 },
				{ timeMs: 300, interactionType: "click" },
			],
			clickSounds: [sound()],
			clickSoundVolume: 1,
		});
		expect(events).toHaveLength(1);
		expect(events[0].sourceTimeMs).toBe(300);
	});

	it("respects the registration's interaction type filter", () => {
		const events = buildClickSoundExportEvents({
			telemetry: [
				{ timeMs: 100, interactionType: "click" },
				{ timeMs: 200, interactionType: "mouseup" },
			],
			clickSounds: [sound({ interactionTypes: ["mouseup"] })],
			clickSoundVolume: 1,
		});
		expect(events).toHaveLength(1);
		expect(events[0].sourceTimeMs).toBe(200);
	});

	it("multiplies extension volume by the mixer volume and clamps to 1 like preview", () => {
		const events = buildClickSoundExportEvents({
			telemetry: [{ timeMs: 100, interactionType: "click" }],
			clickSounds: [sound({ volume: 0.5 })],
			clickSoundVolume: 0.5,
		});
		expect(events[0].gain).toBeCloseTo(0.25);

		const clamped = buildClickSoundExportEvents({
			telemetry: [{ timeMs: 100, interactionType: "click" }],
			clickSounds: [sound({ volume: 1 })],
			clickSoundVolume: 2,
		});
		expect(clamped[0].gain).toBe(1);
	});

	it("drops events when the mix gain rounds to silence", () => {
		const events = buildClickSoundExportEvents({
			telemetry: [{ timeMs: 100, interactionType: "click" }],
			clickSounds: [sound()],
			clickSoundVolume: 0,
		});
		expect(events).toEqual([]);
	});

	it("emits one event per registered sound for the same click", () => {
		const events = buildClickSoundExportEvents({
			telemetry: [{ timeMs: 100, interactionType: "click" }],
			clickSounds: [
				sound({ url: "file:///a.mp3" }),
				sound({ url: "file:///b.mp3", volume: 0.4 }),
			],
			clickSoundVolume: 1,
		});
		expect(events.map((event) => event.audioPath)).toEqual(["file:///a.mp3", "file:///b.mp3"]);
		expect(events[1].gain).toBeCloseTo(0.4);
	});

	it("returns nothing without registrations or telemetry", () => {
		expect(
			buildClickSoundExportEvents({
				telemetry: [],
				clickSounds: [sound()],
				clickSoundVolume: 1,
			}),
		).toEqual([]);
		expect(
			buildClickSoundExportEvents({
				telemetry: [{ timeMs: 100, interactionType: "click" }],
				clickSounds: [],
				clickSoundVolume: 1,
			}),
		).toEqual([]);
	});

	it("skips negative and non-finite timestamps", () => {
		const events = buildClickSoundExportEvents({
			telemetry: [
				{ timeMs: -50, interactionType: "click" },
				{ timeMs: Number.NaN, interactionType: "click" },
				{ timeMs: 400, interactionType: "click" },
			],
			clickSounds: [sound()],
			clickSoundVolume: 1,
		});
		expect(events.map((event) => event.sourceTimeMs)).toEqual([400]);
	});
});
