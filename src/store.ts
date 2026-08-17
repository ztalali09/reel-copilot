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
        cible, douleur, angle, caption)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    shortcode,
    url,
    author,
    judgement.verdict,
    judgement.score,
    judgement.like ? 1 : 0,
    judgement.republier ? 1 : 0,
    judgement.commentaire,
    judgement.cible,
    judgement.douleur,
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

export function recordMeasurement(
  shortcode: string,
  likes: number,
  replies: number,
  repliesText: string,
): void {
  db.prepare(
    `UPDATE reels
     SET likes = ?, replies = ?, replies_text = ?, measured_at = datetime('now')
     WHERE shortcode = ?`,
  ).run(likes, replies, repliesText, shortcode);
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
