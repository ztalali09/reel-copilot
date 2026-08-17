import { createWriteStream } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "../config.js";

// run-sync-get-dataset-items blocks until the run finishes and hands back the items
// directly, which removes the need to poll a run id for a single-URL lookup.
const APIFY_RUN_URL =
  "https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items";

// Apify spins up a container per run, so allow for a cold start. The CDN gets a longer
// leash because slowness there is normal rather than a symptom.
const SCRAPE_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;

// The Instagram CDN drops connections intermittently: the same URL that fails now often
// succeeds seconds later. Retrying is cheaper and more honest than reporting a failure
// the user can only fix by resending the link themselves.
const DOWNLOAD_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 1_500;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface ReelMetadata {
  shortcode: string;
  url: string;
  videoUrl: string;
  /** Instagram serves the audio track on its own. Roughly 20x smaller than the video. */
  audioUrl: string | null;
  /** Cover image, which is usually where the hook text lives. */
  displayUrl: string | null;
  caption: string;
  author: string | null;
  durationSeconds: number | null;
  viewCount: number | null;
  likeCount: number | null;
  hashtags: string[];
  /** Publication time. A comment on a days-old Reel is born buried. */
  postedAt: string | null;
  commentCount: number | null;
  commentsDisabled: boolean;
  /** Existing comments: prospects to answer, and things already said. */
  comments: ReelComment[];
}

export interface ReelComment {
  author: string | null;
  text: string;
  likeCount: number;
}

/** Pulls the shortcode out of a Reel or post URL, ignoring tracking parameters. */
export function parseShortcode(url: string): string | null {
  return /instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? null;
}

export async function scrapeReel(url: string): Promise<ReelMetadata> {
  const shortcode = parseShortcode(url);
  if (!shortcode) throw new Error(`Not an Instagram Reel or post URL: ${url}`);

  const response = await fetch(`${APIFY_RUN_URL}?token=${config.apify.token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      directUrls: [url],
      resultsType: "posts",
      resultsLimit: 1,
      addParentData: false,
    }),
    signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Apify scrape failed (${response.status}): ${await response.text()}`);
  }

  const items = (await response.json()) as {
    videoUrl?: string;
    audioUrl?: string;
    displayUrl?: string;
    videoDuration?: number;
    caption?: string;
    ownerUsername?: string;
    videoViewCount?: number;
    videoPlayCount?: number;
    likesCount?: number;
    hashtags?: string[];
    timestamp?: string;
    commentsCount?: number;
    isCommentsDisabled?: boolean;
    latestComments?: { ownerUsername?: string; text?: string; likesCount?: number }[];
    error?: string;
  }[];

  const item = items[0];
  if (!item) throw new Error("Apify returned no item: the Reel may be private or deleted");
  if (item.error) throw new Error(`Apify: ${item.error}`);
  if (!item.videoUrl) throw new Error("No video URL in the result: is this post a video?");

  return {
    shortcode,
    url,
    videoUrl: item.videoUrl,
    audioUrl: item.audioUrl ?? null,
    displayUrl: item.displayUrl ?? null,
    caption: item.caption?.trim() ?? "",
    author: item.ownerUsername ?? null,
    durationSeconds: item.videoDuration ?? null,
    viewCount: item.videoPlayCount ?? item.videoViewCount ?? null,
    likeCount: item.likesCount ?? null,
    hashtags: item.hashtags ?? [],
    postedAt: item.timestamp ?? null,
    commentCount: item.commentsCount ?? null,
    commentsDisabled: item.isCommentsDisabled ?? false,
    comments: (item.latestComments ?? []).map((c) => ({
      author: c.ownerUsername ?? null,
      text: (c.text ?? "").trim(),
      likeCount: c.likesCount ?? 0,
    })),
  };
}

/** Hours since publication, or null when the timestamp is missing. */
export function ageInHours(metadata: ReelMetadata): number | null {
  if (!metadata.postedAt) return null;
  const posted = Date.parse(metadata.postedAt);
  return Number.isNaN(posted) ? null : (Date.now() - posted) / 3_600_000;
}

/**
 * How crowded the comment section is, per thousand views.
 *
 * A moderately relevant Reel with a dozen comments gives more visibility than a perfect
 * one buried under eight hundred. Relevance decides whether we have something to say;
 * this decides whether anyone will read it.
 */
export function commentDensity(metadata: ReelMetadata): number | null {
  if (!metadata.commentCount || !metadata.viewCount) return null;
  return (metadata.commentCount / metadata.viewCount) * 1000;
}

/**
 * Fetches a CDN asset to a temp file.
 *
 * This is the fast path: pulling the standalone audio track and the cover image costs a
 * few hundred kilobytes, where the full video runs to several megabytes over a CDN that
 * has been measured crawling at 60 KB/s. Same inputs for the judgement, seconds instead
 * of minutes.
 */
export async function downloadAsset(
  url: string,
  filename: string,
  onProgress?: (bytes: number) => void,
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      return await downloadOnce(url, filename, onProgress);
    } catch (error) {
      lastError = error;
      if (attempt < DOWNLOAD_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * RETRY_BACKOFF_MS));
      }
    }
  }

  throw new Error(`Download failed for ${filename} after ${DOWNLOAD_ATTEMPTS} attempts: ${describe(lastError)}`);
}

/**
 * Opens a response stream over IPv4, following redirects.
 *
 * Not fetch. Instagram's CDN advertises AAAA records that are unroutable from many
 * networks, and Node's fetch keeps trying IPv6 regardless of dns.setDefaultResultOrder,
 * failing with an opaque ETIMEDOUT. Measured on the same URL, same second: fetch times
 * out, https.get with family 4 returns 200. So we ask for IPv4 explicitly.
 */
function openIPv4(url: string, redirectsLeft = 5): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = get(
      url,
      {
        family: 4,
        timeout: DOWNLOAD_TIMEOUT_MS,
        // The CDN is friendlier to something that looks like a browser.
        headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "*/*" },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;

        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirectsLeft === 0) return reject(new Error("too many redirects"));
          return resolve(openIPv4(new URL(location, url).toString(), redirectsLeft - 1));
        }
        if (status < 200 || status >= 300) {
          response.resume();
          return reject(new Error(`HTTP ${status}`));
        }
        resolve(response);
      },
    );

    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(new Error("connection timed out"));
    });
  });
}

async function downloadOnce(
  url: string,
  filename: string,
  onProgress?: (bytes: number) => void,
): Promise<string> {
  const response = await openIPv4(url);

  const workDir = await mkdtemp(join(tmpdir(), "reel-copilot-dl-"));
  const filePath = join(workDir, filename);

  let received = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      onProgress?.(received);
      callback(null, chunk);
    },
  });

  await pipeline(response, counter, createWriteStream(filePath));
  return filePath;
}

/**
 * Unwraps the cause of a network failure.
 *
 * Node reports every transport-level problem as a bare "fetch failed" and hides what
 * actually happened (ECONNRESET, ENOTFOUND, a TLS error) one level down in `cause`.
 * Surfacing it is the difference between a usable error and a shrug.
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: string; message?: string } | undefined;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${error.message} (${detail})` : error.message;
}
