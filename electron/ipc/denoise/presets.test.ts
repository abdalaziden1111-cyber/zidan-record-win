import { describe, expect, it } from "vitest";
import {
	buildDenoiseFilterChain,
	clampAfftdnNoiseFloorDb,
	deriveAfftdnNoiseFloorDb,
	escapeFilterPath,
} from "./presets";

const MODELS = { sh: "/models/sh.rnnn", bd: "/models/bd.rnnn" };

describe("escapeFilterPath", () => {
	it("single-quotes plain paths", () => {
		expect(escapeFilterPath("/models/sh.rnnn")).toBe("'/models/sh.rnnn'");
	});

	it("converts Windows backslashes to forward slashes", () => {
		expect(escapeFilterPath("C:\\Users\\Test\\sh.rnnn")).toBe("'C:/Users/Test/sh.rnnn'");
	});

	it("escapes embedded single quotes shell-style", () => {
		expect(escapeFilterPath("/tmp/it's here/sh.rnnn")).toBe("'/tmp/it'\\''s here/sh.rnnn'");
	});
});

describe("clampAfftdnNoiseFloorDb", () => {
	it("clamps into afftdn's accepted [-80, -20] range and rounds", () => {
		expect(clampAfftdnNoiseFloorDb(-100)).toBe(-80);
		expect(clampAfftdnNoiseFloorDb(-5)).toBe(-20);
		expect(clampAfftdnNoiseFloorDb(-34.6)).toBe(-35);
	});
});

describe("deriveAfftdnNoiseFloorDb", () => {
	it("sits headroom above the measured trough", () => {
		// Calibrated: hiss measured at -44.8 dB trough → nf ≈ -39.
		expect(deriveAfftdnNoiseFloorDb(-44.8, -45)).toBe(-39);
	});

	it("falls back when measurement is missing or nonsensical", () => {
		expect(deriveAfftdnNoiseFloorDb(null, -45)).toBe(-45);
		expect(deriveAfftdnNoiseFloorDb(Number.NaN, -38)).toBe(-38);
		expect(deriveAfftdnNoiseFloorDb(3, -45)).toBe(-45);
	});

	it("clamps derived values into range", () => {
		expect(deriveAfftdnNoiseFloorDb(-10, -45)).toBe(-20);
		expect(deriveAfftdnNoiseFloorDb(-95, -45)).toBe(-80);
	});
});

describe("buildDenoiseFilterChain", () => {
	it("maps the light preset to a tracked afftdn with strength-scaled nr", () => {
		expect(buildDenoiseFilterChain({ preset: "light", strength: "low" }).filter).toBe(
			"afftdn=nr=6:nf=-45",
		);
		expect(buildDenoiseFilterChain({ preset: "light", strength: "high" }).filter).toBe(
			"afftdn=nr=14:nf=-45",
		);
	});

	it("prepends a highpass for the hum preset", () => {
		const chain = buildDenoiseFilterChain({ preset: "hum", strength: "medium" });
		expect(chain.filter).toBe("highpass=f=60,afftdn=nr=18:nf=-38");
		expect(chain.usedModel).toBeNull();
	});

	it("uses the measured noise floor for afftdn presets", () => {
		const chain = buildDenoiseFilterChain({
			preset: "hum",
			strength: "medium",
			measuredNoiseFloorDb: -44.8,
		});
		expect(chain.filter).toBe("highpass=f=60,afftdn=nr=18:nf=-39");
	});

	it("maps voice presets to arnndn with mix as strength", () => {
		const low = buildDenoiseFilterChain({
			preset: "voice",
			strength: "low",
			modelPathById: MODELS,
		});
		expect(low.filter).toBe("arnndn=m='/models/sh.rnnn':mix=0.55");
		expect(low.usedModel).toBe("sh");

		const high = buildDenoiseFilterChain({
			preset: "voice-music",
			strength: "high",
			modelPathById: MODELS,
		});
		expect(high.filter).toBe("arnndn=m='/models/bd.rnnn':mix=1");
		expect(high.usedModel).toBe("bd");
	});

	it("chains arnndn then afftdn for the max preset", () => {
		const chain = buildDenoiseFilterChain({
			preset: "max",
			strength: "medium",
			modelPathById: MODELS,
		});
		expect(chain.filter).toBe("arnndn=m='/models/sh.rnnn':mix=0.9,afftdn=nr=10:nf=-45");
		expect(chain.usedModel).toBe("sh");
	});

	it("throws a clear error when the required model is missing", () => {
		expect(() => buildDenoiseFilterChain({ preset: "voice", strength: "medium" })).toThrow(
			/requires the "sh" RNNoise model/,
		);
	});
});
