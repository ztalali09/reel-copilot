import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Whether ffmpeg is on this machine.
 *
 * Instagram links never need it (the audio track is fetched separately), but video files
 * sent to Telegram do. Hosts vary in what they ship, so the bot reports this at startup
 * rather than letting the gap surface as a cryptic ENOENT mid-pipeline.
 */
export async function isFfmpegAvailable(): Promise<boolean> {
  try {
    await run("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

export interface ExtractedMedia {
  /** Mono 16 kHz MP3, the format Whisper was trained on. */
  audioPath: string;
  /** Stills sampled across the Reel, to catch burned-in text. */
  framePaths: string[];
}

/**
 * Pulls an audio track and a handful of stills out of a Reel.
 *
 * Downmixing to mono 16 kHz keeps a minute of audio near 1 MB, which stays well
 * under Groq's 25 MB free-tier ceiling even for unusually long Reels.
 */
export async function extractMedia(videoPath: string, frameCount = 3): Promise<ExtractedMedia> {
  const workDir = await mkdtemp(join(tmpdir(), "reel-copilot-"));
  const audioPath = join(workDir, "audio.mp3");

  await run("ffmpeg", [
    "-loglevel", "error",
    "-y",
    "-i", videoPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-b:a", "64k",
    audioPath,
  ]);

  // Sample evenly rather than taking the first frames: openings are often a
  // title card that says nothing about the substance of the Reel.
  const duration = await probeDuration(videoPath);
  const framePaths: string[] = [];
  for (let i = 0; i < frameCount; i++) {
    const at = (duration * (i + 1)) / (frameCount + 1);
    const framePath = join(workDir, `frame-${i}.jpg`);
    await run("ffmpeg", [
      "-loglevel", "error",
      "-y",
      "-ss", at.toFixed(2),
      "-i", videoPath,
      "-frames:v", "1",
      "-q:v", "4",
      framePath,
    ]);
    framePaths.push(framePath);
  }

  return { audioPath, framePaths };
}

async function probeDuration(videoPath: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    videoPath,
  ]);
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ffprobe returned no usable duration for ${videoPath}`);
  }
  return duration;
}
