import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { resolveUnpackedAppPath } from "../paths/binaries";
import type { DenoiseModelId } from "./presets";

export const DENOISE_MODEL_FILES: Record<DenoiseModelId, { fileName: string; sha256: string }> = {
	sh: {
		fileName: "sh.rnnn",
		sha256: "70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0",
	},
	bd: {
		fileName: "bd.rnnn",
		sha256: "ae3f7411e1e6a884f839a4a145c394408398f09854dbc1216ee02faafc98a17b",
	},
};

export function getBundledDenoiseModelPath(modelId: DenoiseModelId): string {
	return resolveUnpackedAppPath(
		"electron",
		"native",
		"denoise-models",
		DENOISE_MODEL_FILES[modelId].fileName,
	);
}

async function sha256File(filePath: string): Promise<string> {
	const buffer = await fs.readFile(filePath);
	return createHash("sha256").update(buffer).digest("hex");
}

/** Checks which bundled .rnnn model files are present on disk and pass checksum verification. */
export async function resolveDenoiseModelPaths(): Promise<Partial<Record<DenoiseModelId, string>>> {
	const modelIds = Object.keys(DENOISE_MODEL_FILES) as DenoiseModelId[];
	const entries = await Promise.all(
		modelIds.map(async (modelId): Promise<[DenoiseModelId, string | null]> => {
			const modelPath = getBundledDenoiseModelPath(modelId);
			try {
				const hash = await sha256File(modelPath);
				if (hash !== DENOISE_MODEL_FILES[modelId].sha256) {
					console.warn(
						`[denoise] Model "${modelId}" failed checksum verification; ignoring.`,
					);
					return [modelId, null];
				}
				return [modelId, modelPath];
			} catch {
				return [modelId, null];
			}
		}),
	);

	const result: Partial<Record<DenoiseModelId, string>> = {};
	for (const [modelId, modelPath] of entries) {
		if (modelPath) {
			result[modelId] = modelPath;
		}
	}
	return result;
}
