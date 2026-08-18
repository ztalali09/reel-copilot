import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Judgement } from "./pipeline/judge.js";

// Hosted, this points at a mounted volume: without one, every redeploy wipes the history
// and the bot starts re-judging Reels it has already seen.
const DATA_DIR = process.env.DATA_DIR ?? new URL("../data/", import.meta.url).pathname;
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, "reels.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS reels (
    shortcode   TEXT PRIMARY KEY,
    url         TEXT NOT NULL,
    author      TEXT,
    verdict     TEXT NOT NULL,
    score       INTEGER NOT NULL,
    liked       INTEGER NOT NULL,
    reposted    INTEGER NOT NULL,
    comment     TEXT NOT NULL,
    judged_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS reels_author_idx ON reels (author, judged_at);

  -- One row per measurement rather than an overwrite. Twelve likes after two hours and
  -- twelve after ten days are not the same result, and only a series can tell them apart.
  CREATE TABLE IF NOT EXISTS measurements (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    shortcode      TEXT NOT NULL,
    likes          INTEGER NOT NULL,
    replies        INTEGER NOT NULL,
    replies_text   TEXT,
    hours_elapsed  REAL,
    measured_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS measurements_shortcode_idx ON measurements (shortcode, measured_at);
`);

// Added after the first deployments, so they go on as migrations rather than in the
// CREATE above: an existing volume already holds a table without them.
for (const column of [
  "cible TEXT",
  "douleur TEXT",
  "angle TEXT",
  "caption TEXT",
  // Filled by /mesure, once the comment has had time to collect reactions.
  "likes INTEGER",
  "replies INTEGER",
  "replies_text TEXT",
  "measured_at TEXT",
  // Set when you confirm you actually published the comment.
  "posted_at TEXT",
  "sujet TEXT",
  "persona TEXT",
  "objection TEXT",
]) {
  try {
    db.exec(`ALTER TABLE reels ADD COLUMN ${column}`);
  } catch {
    // Already present.
  }
}

export interface PastJudgement {
  shortcode: string;
  author: string | null;
  verdict: string;
  score: number;
  comment: string;
  judgedAt: string;
}

export function findJudged(shortcode: string): PastJudgement | null {
  const row = db
    .prepare(
      `SELECT shortcode, author, verdict, score, comment, judged_at AS judgedAt
       FROM reels WHERE shortcode = ?`,
    )
    .get(shortcode) as PastJudgement | undefined;
  return row ?? null;
}

export function record(
  shortcode: string,
  url: string,
  author: string | null,
  judgement: Judgement,
  caption = "",
): void {
  db.prepare(
    `INSERT OR REPLACE INTO reels
       (shortcode, url, author, verdict, score, liked, reposted, comment,
        sujet, cible, douleur, objection, angle, caption)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    shortcode,
    url,
    author,
    judgement.verdict,
    judgement.score,
    judgement.like ? 1 : 0,
    judgement.republier ? 1 : 0,
    judgement.commentaire,
    judgement.sujet,
    judgement.cible,
    judgement.douleur,
    judgement.objection,
    judgement.angle,
    caption,
  );
}

export interface CommentedReel {
  shortcode: string;
  url: string;
  author: string | null;
  comment: string;
  judgedAt: string;
}

/**
 * Reels we advised commenting on and have not measured recently.
 *
 * Measuring costs one scrape each, so leave a few days: reactions need time to arrive,
 * and re-checking yesterday's comment tells you nothing.
 */
export function listToMeasure(limit = 25): CommentedReel[] {
  return db
    .prepare(
      `SELECT shortcode, url, author, comment, judged_at AS judgedAt
       FROM reels
       WHERE verdict = 'COMMENTER'
         AND comment <> ''
         AND shortcode NOT LIKE 'local-%' AND shortcode NOT LIKE 'shot-%'
         AND julianday('now') - julianday(judged_at) >= 2
         AND (measured_at IS NULL OR julianday('now') - julianday(measured_at) >= 5)
       ORDER BY judged_at DESC
       LIMIT ?`,
    )
    .all(limit) as CommentedReel[];
}

export interface MeasurementDelta {
  likes: number;
  replies: number;
  /** Change since the previous measurement, null on the first one. */
  likesDelta: number | null;
  repliesDelta: number | null;
  /** Hours between publication and this reading — the number that gives the rest meaning. */
  hoursElapsed: number | null;
}

/**
 * Appends a reading and returns how it moved since the last one.
 *
 * Elapsed time is counted from `posted_at` when you confirmed publishing, otherwise from
 * the judgement. Without it a like count is unreadable: fast traction and slow decay
 * produce the same number.
 */
export function recordMeasurement(
  shortcode: string,
  likes: number,
  replies: number,
  repliesText: string,
): MeasurementDelta {
  const previous = db
    .prepare(
      `SELECT likes, replies FROM measurements
       WHERE shortcode = ? ORDER BY measured_at DESC LIMIT 1`,
    )
    .get(shortcode) as { likes: number; replies: number } | undefined;

  const elapsed = db
    .prepare(
      `SELECT (julianday('now') - julianday(COALESCE(posted_at, judged_at))) * 24 AS hours
       FROM reels WHERE shortcode = ?`,
    )
    .get(shortcode) as { hours: number | null } | undefined;
  const hoursElapsed = elapsed?.hours ?? null;

  db.prepare(
    `INSERT INTO measurements (shortcode, likes, replies, replies_text, hours_elapsed)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(shortcode, likes, replies, repliesText, hoursElapsed);

  // Mirrored on the reel row so ranking stays a single cheap query.
  db.prepare(
    `UPDATE reels
     SET likes = ?, replies = ?, replies_text = ?, measured_at = datetime('now')
     WHERE shortcode = ?`,
  ).run(likes, replies, repliesText, shortcode);

  return {
    likes,
    replies,
    likesDelta: previous ? likes - previous.likes : null,
    repliesDelta: previous ? replies - previous.replies : null,
    hoursElapsed,
  };
}

/** Full reading history for one comment, oldest first. */
export function measurementHistory(shortcode: string): {
  likes: number;
  replies: number;
  hoursElapsed: number | null;
  measuredAt: string;
}[] {
  return db
    .prepare(
      `SELECT likes, replies, hours_elapsed AS hoursElapsed, measured_at AS measuredAt
       FROM measurements WHERE shortcode = ? ORDER BY measured_at ASC`,
    )
    .all(shortcode) as {
    likes: number;
    replies: number;
    hoursElapsed: number | null;
    measuredAt: string;
  }[];
}

export interface Reference {
  shortcode: string;
  url: string;
  author: string | null;
  caption: string | null;
  cible: string | null;
  douleur: string | null;
  angle: string | null;
  comment: string;
  likes: number;
  replies: number;
  repliesText: string | null;
  judgedAt: string;
}

/**
 * The library of what worked, ranked by conversation started rather than by popularity.
 *
 * A comment with 150 likes and no reply is applause. One with 30 likes and three replies
 * from people describing their own situation is a conversation, and that is what this is
 * for — so replies weigh an order of magnitude more.
 */
export function listReferences(limit = 15): Reference[] {
  return db
    .prepare(
      `SELECT shortcode, url, author, caption, cible, douleur, angle, comment,
              COALESCE(likes, 0) AS likes,
              COALESCE(replies, 0) AS replies,
              replies_text AS repliesText,
              judged_at AS judgedAt
       FROM reels
       WHERE measured_at IS NOT NULL AND (COALESCE(likes, 0) + COALESCE(replies, 0)) > 0
       ORDER BY (COALESCE(replies, 0) * 10 + COALESCE(likes, 0)) DESC
       LIMIT ?`,
    )
    .all(limit) as Reference[];
}

/**
 * Comments already handed out for this creator today.
 *
 * Commenting the same account repeatedly within a day reads as farming, so the bot
 * surfaces this rather than silently letting it happen.
 */
export function commentsForAuthorToday(author: string | null): number {
  if (!author) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM reels
       WHERE author = ? AND verdict = 'COMMENTER' AND date(judged_at) = date('now')`,
    )
    .get(author) as { n: number };
  return row.n;
}

/** Marks a comment as actually published, and returns the running count for today. */
export function markPosted(shortcode: string, comment: string): number {
  db.prepare(
    `UPDATE reels SET posted_at = datetime('now'), comment = ? WHERE shortcode = ?`,
  ).run(comment, shortcode);
  return postedToday();
}

export function postedToday(): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM reels WHERE date(posted_at) = date('now')`)
    .get() as { n: number };
  return row.n;
}

export function isPosted(shortcode: string): boolean {
  const row = db.prepare(`SELECT posted_at FROM reels WHERE shortcode = ?`).get(shortcode) as
    | { posted_at: string | null }
    | undefined;
  return Boolean(row?.posted_at);
}

/** Publications per day over the last `days` days, most recent first. */
export function postedHistory(days = 7): { day: string; count: number }[] {
  return db
    .prepare(
      `SELECT date(posted_at) AS day, COUNT(*) AS count
       FROM reels
       WHERE posted_at IS NOT NULL AND julianday('now') - julianday(posted_at) < ?
       GROUP BY day ORDER BY day DESC`,
    )
    .all(days) as { day: string; count: number }[];
}

/** Today's counters, to keep the daily cadence honest. */
export function todayStats(): { judged: number; toComment: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS judged,
              SUM(CASE WHEN verdict = 'COMMENTER' THEN 1 ELSE 0 END) AS toComment
       FROM reels WHERE date(judged_at) = date('now')`,
    )
    .get() as { judged: number; toComment: number | null };
  return { judged: row.judged, toComment: row.toComment ?? 0 };
}
