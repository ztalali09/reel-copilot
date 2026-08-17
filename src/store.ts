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
): void {
  db.prepare(
    `INSERT OR REPLACE INTO reels
       (shortcode, url, author, verdict, score, liked, reposted, comment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    shortcode,
    url,
    author,
    judgement.verdict,
    judgement.score,
    judgement.like ? 1 : 0,
    judgement.republier ? 1 : 0,
    judgement.commentaire,
  );
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
