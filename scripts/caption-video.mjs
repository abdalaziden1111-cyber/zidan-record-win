#!/usr/bin/env node
/**
 * caption-video.mjs — standalone Whisper auto-captioning script (Phase 1)
 *
 * Completely free and offline — uses the bundled whisper-cli binary.
 * No API key needed.
 *
 * Usage:
 *   node scripts/caption-video.mjs <video-path> [options]
 *
 * Options:
 *   --model <path>   Path to ggml model file (auto-downloads ggml-small if missing)
 *   --lang <lang>    Language hint, e.g. "ar", "en" (default: auto)
 *   --out <dir>      Output directory (default: same folder as video)
 *   --dry-run        Mock whisper — no computation, instant output for pipeline testing
 *   --debug          Print detailed pipeline logs
 *
 * Outputs:
 *   <video-base>.srt   SubRip subtitle file
 *   <video-base>.vtt   WebVTT subtitle file
 */

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import { get as httpsGet } from "node:https";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(
	decodeURIComponent(new URL(".", import.meta.url).pathname),
	"..",
);
const WHISPER_MODEL_DEFAULT_DIR = path.join(
	os.homedir(),
	"Library",
	"Application Support",
	"Recordly",
	"whisper",
);
const WHISPER_MODEL_DEFAULT_PATH = path.join(WHISPER_MODEL_DEFAULT_DIR, "ggml-small.bin");
const WHISPER_MODEL_DOWNLOAD_URL =
	"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";

function getWhisperBinaryPath() {
	const arch = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	const bundled = path.join(REPO_ROOT, "electron", "native", "bin", arch, "whisper-cli");
	if (existsSync(bundled)) return bundled;

	// Fallback: system
	for (const p of ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"]) {
		if (existsSync(p)) return p;
	}

	throw new Error(
		"whisper-cli not found. Expected at electron/native/bin/darwin-arm64/whisper-cli",
	);
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const args = argv.slice(2);
	const opts = {
		videoPath: null,
		modelPath: null,
		lang: null,
		outDir: null,
		dryRun: false,
		debug: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "--help":
			case "-h":
				printUsageAndExit(0);
				break;
			case "--model":
				opts.modelPath = args[++i] ?? null;
				break;
			case "--lang":
				opts.lang = args[++i] ?? null;
				break;
			case "--out":
				opts.outDir = args[++i] ?? null;
				break;
			case "--dry-run":
				opts.dryRun = true;
				break;
			case "--debug":
				opts.debug = true;
				break;
			default:
				if (!arg.startsWith("--") && !opts.videoPath) {
					opts.videoPath = arg;
				} else if (arg.startsWith("--")) {
					console.error(`Unknown option: ${arg}`);
					printUsageAndExit(1);
				}
		}
	}

	return opts;
}

function printUsageAndExit(code = 0) {
	console.log(`
Usage: node scripts/caption-video.mjs <video-path> [options]

Options:
  --model <path>   ggml model file (auto-downloads ggml-small.bin if missing)
  --lang <lang>    Language hint: "ar", "en", etc. (default: auto-detect)
  --out <dir>      Output directory (default: same folder as video)
  --dry-run        Mock whisper — instant output, no computation
  --debug          Verbose logs
`);
	process.exit(code);
}

// ---------------------------------------------------------------------------
// ffmpeg discovery
// ---------------------------------------------------------------------------

function resolveFfmpeg() {
	try {
		const p = require("ffmpeg-static");
		const candidate = typeof p === "string" ? p : (p?.default ?? null);
		if (candidate && existsSync(candidate)) return candidate;
	} catch {
		// not installed
	}

	for (const p of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
		if (existsSync(p)) return p;
	}

	throw new Error(
		"ffmpeg not found. It should be in node_modules/ffmpeg-static — try: npm install",
	);
}

// ---------------------------------------------------------------------------
// Audio extraction: video → 16kHz mono WAV (best whisper compatibility)
// ---------------------------------------------------------------------------

async function extractAudio(videoPath, ffmpegPath, tempDir, debug) {
	const wavPath = path.join(tempDir, `caption-audio-${Date.now()}.wav`);

	const args = [
		"-y",
		"-i", videoPath,
		"-map", "0:a:0",
		"-vn",
		"-ac", "1",
		"-ar", "16000",
		"-c:a", "pcm_s16le",
		wavPath,
	];

	if (debug) console.log("[debug] ffmpeg:", args.join(" "));

	try {
		await execFileAsync(ffmpegPath, args, {
			timeout: 10 * 60 * 1000,
			maxBuffer: 50 * 1024 * 1024,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/matches no streams|Output file #0 does not contain any stream|no audio|invalid data/i.test(msg)) {
			throw new Error("No audio detected — captions skipped.");
		}
		throw new Error(`ffmpeg audio extraction failed: ${msg}`);
	}

	const stat = await fs.stat(wavPath);
	if (debug) console.log(`[debug] audio: ${wavPath} (${(stat.size / 1024).toFixed(0)} KB)`);
	return wavPath;
}

// ---------------------------------------------------------------------------
// Model download
// ---------------------------------------------------------------------------

function downloadWithProgress(url, destPath, onProgress) {
	const request = (currentUrl, redirectCount = 0) =>
		new Promise((resolve, reject) => {
			const req = httpsGet(currentUrl, { timeout: 30_000 }, (res) => {
				const status = res.statusCode ?? 0;
				const location = res.headers.location;

				if (status >= 300 && status < 400 && location) {
					res.resume();
					if (redirectCount >= 8) return reject(new Error("Too many redirects"));
					request(new URL(location, currentUrl).toString(), redirectCount + 1)
						.then(resolve)
						.catch(reject);
					return;
				}

				if (status < 200 || status >= 300) {
					res.resume();
					return reject(new Error(`Download failed with status ${status}`));
				}

				const total = Number.parseInt(String(res.headers["content-length"] ?? "0"), 10);
				let downloaded = 0;
				const file = createWriteStream(destPath);

				res.on("data", (chunk) => {
					downloaded += chunk.length;
					if (total > 0) onProgress(Math.min(100, Math.round((downloaded / total) * 100)));
				});
				res.on("error", (e) => file.destroy(e));
				file.on("error", (e) => { res.destroy(e); reject(e); });
				file.on("finish", () => { onProgress(100); resolve(); });
				res.pipe(file);
			});

			req.on("error", reject);
			req.on("timeout", () => req.destroy(new Error("Download timed out")));
		});

	return request(url);
}

async function ensureWhisperModel(modelPath, debug) {
	if (existsSync(modelPath)) {
		if (debug) console.log(`[debug] model found: ${modelPath}`);
		return modelPath;
	}

	console.log(`\nWhisper model not found. Downloading ggml-small.bin (~244 MB)...`);
	console.log(`  From: ${WHISPER_MODEL_DOWNLOAD_URL}`);
	console.log(`  To  : ${modelPath}\n`);

	await fs.mkdir(path.dirname(modelPath), { recursive: true });
	const tempPath = `${modelPath}.download`;

	let lastPct = -1;
	try {
		await downloadWithProgress(WHISPER_MODEL_DOWNLOAD_URL, tempPath, (pct) => {
			if (pct !== lastPct && pct % 5 === 0) {
				process.stdout.write(`\r  Downloading... ${pct}%   `);
				lastPct = pct;
			}
		});
		await fs.rename(tempPath, modelPath);
		console.log("\n  Download complete.\n");
	} catch (err) {
		await fs.rm(tempPath, { force: true }).catch(() => {});
		throw new Error(`Model download failed: ${err.message}`);
	}

	return modelPath;
}

// ---------------------------------------------------------------------------
// Whisper transcription
// ---------------------------------------------------------------------------

async function runWhisper(opts) {
	const { wavPath, whisperPath, modelPath, lang, outputBase, debug } = opts;

	const args = [
		"-m", modelPath,
		"-f", wavPath,
		"-osrt",
		"-of", outputBase,
		"-l", lang || "auto",
		"-np",
	];

	if (debug) console.log("[debug] whisper:", [whisperPath, ...args].join(" "));

	try {
		await execFileAsync(whisperPath, args, {
			timeout: 30 * 60 * 1000,
			maxBuffer: 20 * 1024 * 1024,
		});
	} catch (err) {
		// Some whisper builds exit non-zero but still produce output — check below
		if (debug) console.warn("[debug] whisper exited with error:", err.message?.slice(0, 200));
	}

	const srtPath = `${outputBase}.srt`;
	if (!existsSync(srtPath)) {
		throw new Error("Whisper finished but produced no SRT file. Try a different model.");
	}

	return fs.readFile(srtPath, "utf-8");
}

// ---------------------------------------------------------------------------
// SRT parsing
// ---------------------------------------------------------------------------

function parseSrtTimestamp(value) {
	const m = value.trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
	if (!m) return null;
	return (
		Number(m[1]) * 3_600_000 +
		Number(m[2]) * 60_000 +
		Number(m[3]) * 1_000 +
		Number(m[4])
	);
}

function parseSrtToSegments(srtContent) {
	return srtContent
		.split(/\r?\n\r?\n/)
		.map((block, i) => {
			const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
			const timingIdx = lines.findIndex((l) => l.includes("-->"));
			if (timingIdx < 0) return null;

			const [rawStart, rawEnd] = lines[timingIdx].split("-->").map((p) => p.trim());
			const startMs = parseSrtTimestamp(rawStart);
			const endMs = parseSrtTimestamp(rawEnd);
			if (startMs == null || endMs == null || endMs <= startMs) return null;

			const text = lines.slice(timingIdx + 1).join(" ").trim();
			if (!text) return null;

			return { id: i + 1, startMs, endMs, text };
		})
		.filter(Boolean);
}

// ---------------------------------------------------------------------------
// SRT + VTT output
// ---------------------------------------------------------------------------

function msToSrtTimestamp(ms) {
	const h = Math.floor(ms / 3_600_000);
	const m = Math.floor((ms % 3_600_000) / 60_000);
	const s = Math.floor((ms % 60_000) / 1_000);
	const rest = ms % 1_000;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(rest).padStart(3, "0")}`;
}

function msToVttTimestamp(ms) {
	return msToSrtTimestamp(ms).replace(",", ".");
}

function segmentsToSrt(segments) {
	return segments
		.map((s) => `${s.id}\n${msToSrtTimestamp(s.startMs)} --> ${msToSrtTimestamp(s.endMs)}\n${s.text}`)
		.join("\n\n");
}

function segmentsToVtt(segments) {
	return (
		"WEBVTT\n\n" +
		segments
			.map((s) => `${s.id}\n${msToVttTimestamp(s.startMs)} --> ${msToVttTimestamp(s.endMs)}\n${s.text}`)
			.join("\n\n")
	);
}

// ---------------------------------------------------------------------------
// Dry-run mock
// ---------------------------------------------------------------------------

function buildDryRunSegments() {
	return [
		{ id: 1, startMs: 0,    endMs: 3500,  text: "This is a dry-run caption — no whisper computation." },
		{ id: 2, startMs: 3600, endMs: 7200,  text: "Use --dry-run to test the pipeline instantly." },
		{ id: 3, startMs: 7300, endMs: 11000, text: "Remove the flag to transcribe with the real Whisper." },
	];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const opts = parseArgs(process.argv);

	if (!opts.videoPath) {
		console.error("Error: no video path provided.\n");
		printUsageAndExit(1);
	}

	if (!existsSync(opts.videoPath)) {
		console.error(`Error: file not found: ${opts.videoPath}`);
		process.exit(1);
	}

	const videoAbsPath = path.resolve(opts.videoPath);
	const videoDir = path.dirname(videoAbsPath);
	const videoBase = path.join(
		opts.outDir ?? videoDir,
		path.basename(videoAbsPath, path.extname(videoAbsPath)),
	);
	const srtOut = `${videoBase}.srt`;
	const vttOut = `${videoBase}.vtt`;

	const debug = opts.debug ? (...a) => console.log(...a) : () => {};

	console.log(`\nRecordly caption-video — ${opts.dryRun ? "DRY RUN" : "Whisper (offline, free)"}`);
	console.log(`  Input : ${videoAbsPath}`);
	console.log(`  Output: ${srtOut}`);

	// 1. Resolve binaries
	let ffmpegPath, whisperPath;
	try {
		ffmpegPath = resolveFfmpeg();
		debug(`[debug] ffmpeg: ${ffmpegPath}`);
		if (!opts.dryRun) {
			whisperPath = getWhisperBinaryPath();
			debug(`[debug] whisper-cli: ${whisperPath}`);
		}
	} catch (err) {
		console.error(`Error: ${err.message}`);
		process.exit(1);
	}

	// 2. Ensure whisper model
	let modelPath;
	if (!opts.dryRun) {
		try {
			modelPath = await ensureWhisperModel(
				opts.modelPath ?? WHISPER_MODEL_DEFAULT_PATH,
				opts.debug,
			);
		} catch (err) {
			console.error(`Error: ${err.message}`);
			process.exit(1);
		}
	}

	// 3. Extract audio
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-captions-"));

	try {
		console.log("\n[1/3] Extracting audio...");
		let wavPath;
		try {
			wavPath = await extractAudio(videoAbsPath, ffmpegPath, tempDir, opts.debug);
			const stat = await fs.stat(wavPath);
			console.log(`       ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
		} catch (err) {
			if (err.message.startsWith("No audio detected")) {
				console.log(`\n${err.message}`);
				process.exit(0);
			}
			throw err;
		}

		// 4. Transcribe
		console.log("\n[2/3] Transcribing...");
		let segments;

		if (opts.dryRun) {
			console.log("       [dry-run] skipping whisper, using mock cues");
			segments = buildDryRunSegments();
		} else {
			const outputBase = path.join(tempDir, "whisper-out");
			const srtContent = await runWhisper({
				wavPath,
				whisperPath,
				modelPath,
				lang: opts.lang,
				outputBase,
				debug: opts.debug,
			});

			segments = parseSrtToSegments(srtContent);
			if (segments.length === 0) {
				console.log("\nWhisper produced no captions (silent or unrecognised audio).");
				process.exit(0);
			}
		}

		console.log(`       ${segments.length} segments`);

		// 5. Write files
		console.log("\n[3/3] Writing caption files...");
		if (opts.outDir) await fs.mkdir(opts.outDir, { recursive: true });
		await fs.writeFile(srtOut, segmentsToSrt(segments), "utf-8");
		await fs.writeFile(vttOut, segmentsToVtt(segments), "utf-8");

		console.log(`\nDone!`);
		console.log(`  SRT: ${srtOut}`);
		console.log(`  VTT: ${vttOut}`);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}
}

main().catch((err) => {
	console.error("\nUnexpected error:", err.message ?? err);
	if (process.argv.includes("--debug")) console.error(err);
	process.exit(1);
});
