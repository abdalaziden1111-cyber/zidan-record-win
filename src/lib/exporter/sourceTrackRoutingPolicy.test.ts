import { describe, expect, it } from "vitest";
import { resolveSourceTrackRoutingPolicy } from "./sourceTrackRoutingPolicy";

describe("resolveSourceTrackRoutingPolicy", () => {
	it("prioritizes system+mic sidecars and mutes embedded preview", () => {
		const policy = resolveSourceTrackRoutingPolicy("/tmp/recording.mp4", [
			"/tmp/recording.mp4",
			"/tmp/recording.system.wav",
			"/tmp/recording.mic.wav",
			"/tmp/recording.mixed.wav",
		]);

		expect(policy.playbackPaths).toEqual([
			"/tmp/recording.system.wav",
			"/tmp/recording.mic.wav",
		]);
		expect(policy.muteEmbeddedPreview).toBe(true);
		expect(policy.includeEmbeddedInExport).toBe(false);
	});

	it("falls back to mixed when dedicated tracks are absent", () => {
		const policy = resolveSourceTrackRoutingPolicy("/tmp/recording.mp4", [
			"/tmp/recording.mixed.wav",
		]);

		expect(policy.playbackPaths).toEqual(["/tmp/recording.mixed.wav"]);
		expect(policy.muteEmbeddedPreview).toBe(false);
		expect(policy.includeEmbeddedInExport).toBe(false);
	});

	it("keeps embedded audio when only mic sidecar is present", () => {
		const policy = resolveSourceTrackRoutingPolicy("/tmp/recording.mp4", [
			"/tmp/recording.mp4",
			"/tmp/recording.mic.wav",
		]);

		expect(policy.playbackPaths).toEqual(["/tmp/recording.mic.wav"]);
		expect(policy.muteEmbeddedPreview).toBe(false);
		expect(policy.includeEmbeddedInExport).toBe(true);
	});

	it("mutes embedded preview when a denoised mixed replacement is present", () => {
		const policy = resolveSourceTrackRoutingPolicy("/tmp/recording.mp4", [
			"/tmp/cache/abc123.denoised.mixed.wav",
		]);

		expect(policy.playbackPaths).toEqual(["/tmp/cache/abc123.denoised.mixed.wav"]);
		expect(policy.muteEmbeddedPreview).toBe(true);
		expect(policy.includeEmbeddedInExport).toBe(false);
	});

	it("does not mute embedded preview for a plain (non-denoised) mixed sidecar", () => {
		const policy = resolveSourceTrackRoutingPolicy("/tmp/recording.mp4", [
			"/tmp/recording.mixed.wav",
		]);

		expect(policy.muteEmbeddedPreview).toBe(false);
	});
});
