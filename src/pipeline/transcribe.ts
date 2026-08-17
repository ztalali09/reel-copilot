import { openAsBlob } from "node:fs";
import { config } from "../config.js";

const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

// Groq transcribes a Reel in seconds. A minute means something is wrong, not slow.
const TRANSCRIBE_TIMEOUT_MS = 60_000;

export interface Transcript {
  text: string;
  language: string;
  /** Empty when the Reel carries no speech, which is a meaningful signal by itself. */
  segments: { start: number; end: number; text: string }[];
}

/**
 * Transcribes an audio file through Groq's Whisper endpoint.
 *
 * Pass `language` when you already know it. Whisper's auto-detection is reliable on
 * clear speech but drifts on short clips with music underneath, and a wrong guess
 * produces confident nonsense rather than an error.
 */
export async function transcribe(audioPath: string, language?: string): Promise<Transcript> {
  const form = new FormData();
  form.set("file", await openAsBlob(audioPath), "audio.mp3");
  form.set("model", config.groq.model);
  form.set("response_format", "verbose_json");
  if (language) form.set("language", language);

  const response = await fetch(GROQ_TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.groq.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Groq transcription failed (${response.status}): ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    text: string;
    language?: string;
    segments?: { start: number; end: number; text: string }[];
  };

  return {
    text: payload.text.trim(),
    language: payload.language ?? language ?? "unknown",
    segments:
      payload.segments?.map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })) ?? [],
  };
}
