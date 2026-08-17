import { Bot, GrammyError, InlineKeyboard, type Context, type Filter } from "grammy";
import { createWriteStream } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { config } from "./config.js";
import { extractMedia, isFfmpegAvailable } from "./pipeline/audio.js";
import { judge, refine, type Judgement } from "./pipeline/judge.js";
import {
  ageInHours,
  commentDensity,
  downloadAsset,
  parseShortcode,
  scrapeReel,
  type ReelMetadata,
} from "./pipeline/scrape.js";
import { transcribe, type Transcript } from "./pipeline/transcribe.js";
import { Queue } from "./queue.js";
import {
  commentsForAuthorToday,
  findJudged,
  listReferences,
  listToMeasure,
  record,
  recordMeasurement,
  todayStats,
} from "./store.js";

const bot = new Bot(config.telegram.token);

// Two at a time keeps a batch moving without approaching Gemini's free-tier ceiling.
const QUEUE_CONCURRENCY = 2;
const queue = new Queue(QUEUE_CONCURRENCY);

// Telegram throttles message edits; 3 seconds keeps the counter alive without hitting it.
const EDIT_THROTTLE_MS = 3_000;

// Each measurement is one scrape, so cap a manual run rather than sweeping everything.
const MEASURE_BATCH = 15;

const REFINE_KEYBOARD = new InlineKeyboard()
  .text("Plus court", "refine:court")
  .text("Plus direct", "refine:direct")
  .row()
  .text("Autre angle", "refine:angle");

const REFINE_INSTRUCTIONS: Record<string, string> = {
  court: "raccourcis-le nettement, garde l'idee mais coupe tout ce qui n'est pas essentiel",
  direct: "va droit au but, retire les precautions et les formules d'attenuation",
  angle: "change completement d'angle, pars d'un autre aspect du Reel",
};

/** Context of recently proposed comments, so a reformulation can be regenerated. */
const pending = new Map<number, { metadata: ReelMetadata; transcript: Transcript; comment: string }>();
const PENDING_LIMIT = 200;

type TextContext = Filter<Context, "message:text">;

// Single-user bot. Anything from another account is dropped before it costs a credit.
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== config.telegram.ownerId) return;
  await next();
});

bot.callbackQuery(/^refine:(.+)$/, async (ctx) => {
  const key = ctx.match[1] ?? "";
  const instruction = REFINE_INSTRUCTIONS[key];
  const messageId = ctx.callbackQuery.message?.message_id;
  const context = messageId ? pending.get(messageId) : undefined;

  if (!instruction || !context) {
    return ctx.answerCallbackQuery("Ce commentaire est trop ancien, renvoie le Reel.");
  }

  await ctx.answerCallbackQuery("Je reecris...");
  try {
    const rewritten = await refine(
      context.metadata,
      context.transcript,
      context.comment,
      instruction,
    );

    const sent = await ctx.reply(`<code>${escapeHtml(rewritten)}</code>`, {
      parse_mode: "HTML",
      reply_markup: REFINE_KEYBOARD,
    });
    // Chain from the new version, so asking twice keeps refining rather than looping back.
    pending.set(sent.message_id, { ...context, comment: rewritten });
  } catch (error) {
    await ctx.reply(`Echec : ${error instanceof Error ? error.message : String(error)}`);
  }
});

bot.command("start", (ctx) =>
  ctx.reply(
    "Envoie-moi un lien de Reel, ou directement un fichier video.\n" +
      "Je regarde, j'ecoute, et je te dis quoi faire — y compris de passer ton chemin.",
  ),
);

// Answers instantly and touches nothing else: the one command that tells you the bot is
// alive when a job appears stuck.
bot.command("ping", (ctx) => {
  const busy = queue.depth;
  return ctx.reply(
    busy > 0 ? `Vivant. ${busy} Reel(s) en cours de traitement.` : "Vivant, et au repos.",
  );
});

/**
 * Goes back over the Reels we commented on and records what the comment collected.
 *
 * One scrape each, so it is manual and capped rather than automatic: measuring fifty
 * comments costs around 0.14 EUR, and there is nothing to learn from re-checking a
 * comment posted yesterday.
 */
bot.command("mesure", async (ctx) => {
  const brand = config.brand.instagramHandle;
  if (!brand) {
    return ctx.reply("BRAND_INSTAGRAM_HANDLE n'est pas defini : impossible de retrouver tes commentaires.");
  }

  const targets = listToMeasure(MEASURE_BATCH);
  if (targets.length === 0) {
    return ctx.reply("Rien a mesurer. Les commentaires de moins de 2 jours sont ignores.");
  }

  const sent = await ctx.reply(`Mesure de ${targets.length} commentaire(s)...`);
  let found = 0;
  let missing = 0;
  const lines: string[] = [];

  for (const target of targets) {
    try {
      const metadata = await queue.add(() => scrapeReel(target.url));
      const mine = metadata.comments.find((c) => c.author?.toLowerCase() === brand);
      if (!mine) {
        // Either not posted, or pushed out of the comments Apify returns.
        missing++;
        continue;
      }
      const repliesText = mine.replies.map((r) => `@${r.author ?? "?"} : ${r.text}`).join("\n");
      recordMeasurement(target.shortcode, mine.likeCount, mine.replyCount, repliesText);
      found++;
      lines.push(
        `@${metadata.author ?? "?"} — ${mine.likeCount} like(s), ${mine.replyCount} reponse(s)`,
      );
    } catch {
      missing++;
    }
  }

  await ctx.api.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {});
  await ctx.reply(
    `<b>${found} mesure(s)</b>${missing ? `, ${missing} introuvable(s)` : ""}\n\n` +
      (lines.join("\n") || "Aucun de tes commentaires n'a ete retrouve.") +
      `\n\nCout : ~${(targets.length * 0.0027).toFixed(3)} USD`,
    { parse_mode: "HTML" },
  );
});

/**
 * The reference library: what actually worked, in your voice.
 *
 * Ranked by replies rather than likes. Likes are applause; replies mean someone answered,
 * which is the only reaction that resembles the point of commenting at all.
 */
bot.command("refs", (ctx) => {
  const refs = listReferences(10);
  if (refs.length === 0) {
    return ctx.reply(
      "Bibliotheque vide. Commente, attends deux jours, puis lance /mesure.",
    );
  }

  const blocks = refs.map((r, i) => {
    const parts = [
      `<b>${i + 1}. ${r.replies} reponse(s) · ${r.likes} like(s)</b>`,
      `Createur : @${r.author ?? "?"} · ${r.judgedAt.slice(0, 10)}`,
      r.cible ? `Audience : ${escapeHtml(r.cible)}` : "",
      r.douleur ? `Douleur : ${escapeHtml(r.douleur)}` : "",
      r.angle ? `Angle : ${escapeHtml(r.angle)}` : "",
      `<code>${escapeHtml(r.comment)}</code>`,
    ];
    if (r.repliesText) {
      parts.push(`<i>Reponses recues :</i>\n${escapeHtml(r.repliesText.slice(0, 300))}`);
    }
    return parts.filter(Boolean).join("\n");
  });

  return ctx.reply(
    `<b>Tes meilleures interventions</b>\n<i>classees par conversation declenchee, pas par likes</i>\n\n` +
      blocks.join("\n\n———\n\n"),
    { parse_mode: "HTML" },
  );
});

bot.command("stats", (ctx) => {
  const { judged, toComment } = todayStats();
  return ctx.reply(
    `Aujourd'hui : ${judged} Reels analyses, ${toComment} qui meritent un commentaire.`,
  );
});

bot.on("message:text", async (ctx) => {
  // Several links in one message is the normal way to work through a batch, so take
  // them all rather than only the first.
  const urls = [...new Set(ctx.message.text.match(/https?:\/\/\S*instagram\.com\/\S+/g) ?? [])];
  if (urls.length === 0) {
    return ctx.reply("Je ne vois pas de lien Instagram la-dedans.");
  }

  if (urls.length > 1) {
    await ctx.reply(`${urls.length} Reels recus. Je les traite ${QUEUE_CONCURRENCY} par ${QUEUE_CONCURRENCY}.`);
  }

  for (const url of urls) {
    void handleReelUrl(ctx, url);
  }
});

async function handleReelUrl(ctx: TextContext, url: string): Promise<void> {
  const shortcode = parseShortcode(url);
  if (shortcode) {
    const past = findJudged(shortcode);
    if (past) {
      await ctx.reply(
        `Deja juge le ${past.judgedAt} : ${past.verdict} (${past.score}/100).` +
          (past.comment ? `\n\n${past.comment}` : ""),
      );
      return;
    }
  }

  const queued = queue.depth >= QUEUE_CONCURRENCY;
  const sent = await ctx.reply(queued ? "En file d'attente..." : "Demarrage...");
  const status = createStatus(ctx, sent.message_id);

  try {
    await queue.add(async () => {
      status.step("Recuperation du Reel");
      const metadata = await scrapeReel(url);

      // Both checks settle the question before spending a transcription and a judgement.
      if (metadata.commentsDisabled) {
        await ctx.api.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {});
        await ctx.reply("Les commentaires sont desactives sur ce Reel. Rien a faire ici.");
        return;
      }

      const brand = config.brand.instagramHandle;
      const own = brand && metadata.comments.find((c) => c.author?.toLowerCase() === brand);
      if (own) {
        await ctx.api.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {});
        await ctx.reply(
          `Tu as deja commente ce Reel (${own.likeCount} like${own.likeCount > 1 ? "s" : ""}) :\n\n` +
            `<code>${escapeHtml(own.text)}</code>`,
          { parse_mode: "HTML" },
        );
        return;
      }

      const progress = (bytes: number) => status.detail(`${(bytes / 1_000_000).toFixed(1)} Mo`);
      let audioPath: string;
      let framePaths: string[];

      if (metadata.audioUrl) {
        // Fast path: the standalone audio track plus the cover, a few hundred KB total.
        status.step("Telechargement audio");
        audioPath = await downloadAsset(metadata.audioUrl, "audio.m4a", progress);
        framePaths = metadata.displayUrl
          ? [await downloadAsset(metadata.displayUrl, "cover.jpg")]
          : [];
      } else {
        // Some posts expose no separate audio, so fall back to pulling the whole video.
        status.step("Telechargement video");
        const videoPath = await downloadAsset(metadata.videoUrl, "reel.mp4", progress);
        status.step("Extraction audio et images");
        ({ audioPath, framePaths } = await extractMedia(videoPath));
      }

      const { verdict, transcript } = await runJudgement(metadata, audioPath, framePaths, status);

      await ctx.api.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {});
      await sendVerdict(ctx, metadata, verdict, transcript);
    });
  } catch (error) {
    await status.fail(error);
  }
}

/**
 * Metadata for something sent straight to Telegram.
 *
 * A file or a screenshot carries none of what Instagram exposes: no age, no comment
 * section, no author. The judgement then rests on the media alone.
 */
function localMetadata(shortcode: string, url: string, caption: string): ReelMetadata {
  return {
    shortcode,
    url,
    videoUrl: "",
    audioUrl: null,
    displayUrl: null,
    caption,
    author: null,
    durationSeconds: null,
    viewCount: null,
    likeCount: null,
    hashtags: [],
    postedAt: null,
    commentCount: null,
    commentsDisabled: false,
    comments: [],
  };
}

export interface Status {
  step: (label: string) => void;
  detail: (text: string) => void;
  fail: (error: unknown) => Promise<void>;
}

/**
 * A single status message that keeps showing signs of life.
 *
 * The elapsed counter is the point: the Instagram CDN can crawl at 60 KB/s, so a long
 * wait is often normal. Without a moving number there is no way to tell "still working"
 * from "hung", and the only honest answer to "should I wait?" is a clock.
 *
 * Telegram rate-limits edits, hence the throttle.
 */
function createStatus(ctx: TextContext, messageId: number): Status {
  const startedAt = Date.now();
  let label = "Demarrage";
  let detail = "";
  let lastEditAt = 0;
  let inFlight = false;

  const render = (force = false) => {
    const now = Date.now();
    if (!force && (inFlight || now - lastEditAt < EDIT_THROTTLE_MS)) return;
    lastEditAt = now;
    inFlight = true;

    const elapsed = Math.round((now - startedAt) / 1000);
    const text = `${label}${detail ? ` · ${detail}` : ""} · ${elapsed}s`;
    void ctx.api
      .editMessageText(ctx.chat.id, messageId, text)
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
  };

  // Tick independently of progress events: ffmpeg and Gemini emit nothing while they work.
  const heartbeat = setInterval(() => render(), EDIT_THROTTLE_MS);
  heartbeat.unref();

  return {
    step(next: string) {
      label = next;
      detail = "";
      render(true);
    },
    detail(text: string) {
      detail = text;
      render();
    },
    async fail(error: unknown) {
      clearInterval(heartbeat);
      // Node buries transport errors one level down, so "fetch failed" alone says nothing.
      const base = error instanceof Error ? error.message : String(error);
      const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
      const detail = cause?.code ?? cause?.message;
      const message = detail ? `${base} (${detail})` : base;
      const hint = /timed out|aborted/i.test(message)
        ? "\n(delai depasse — le CDN Instagram ou l'API n'a pas repondu a temps)"
        : "";
      await ctx.api
        .editMessageText(ctx.chat.id, messageId, `Echec pendant "${label}" : ${message}${hint}`)
        .catch(() => {});
    },
  };
}

// A screenshot is often the fastest way to ask: you are scrolling, something catches your
// eye, you capture it. There is no audio, so the judgement rests on what the image shows —
// which for a Reel screenshot is usually the burned-in hook plus the caption.
bot.on("message:photo", async (ctx) => {
  const photo = ctx.message.photo.at(-1);
  if (!photo) return;

  const sent = await ctx.reply("Lecture de l'image...");
  const status = createStatus(ctx as unknown as TextContext, sent.message_id);

  try {
    const imagePath = await downloadTelegramFile(photo.file_id, "screenshot.jpg");
    const metadata = localMetadata(
      `shot-${photo.file_unique_id}`,
      "(capture d'ecran)",
      ctx.message.caption?.trim() ?? "",
    );

    await queue.add(async () => {
      status.step("Jugement");
      const transcript = { text: "", language: "inconnue", segments: [] };
      const verdict = await judge(metadata, transcript, [imagePath]);
      record(metadata.shortcode, metadata.url, metadata.author, verdict, metadata.caption);

      await ctx.api.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {});
      await sendVerdict(ctx, metadata, verdict, transcript);
    });
  } catch (error) {
    await status.fail(error);
  }
});

// Sending a video file skips scraping entirely, which is the quickest way to exercise
// the judgement pass without spending Apify credits.
bot.on(["message:video", "message:document"], async (ctx) => {
  const fileId = ctx.message.video?.file_id ?? ctx.message.document?.file_id;
  if (!fileId) return;

  const sent = await ctx.reply("Telechargement...");
  const status = createStatus(ctx as unknown as TextContext, sent.message_id);

  try {
    const videoPath = await downloadTelegramFile(fileId);
    const metadata = localMetadata(
      `local-${fileId.slice(0, 12)}`,
      "(fichier envoye directement)",
      ctx.message.caption?.trim() ?? "",
    );

    await queue.add(async () => {
      // A file sent straight to Telegram has no separate audio track, so ffmpeg splits it.
      status.step("Extraction audio et images");
      const { audioPath, framePaths } = await extractMedia(videoPath);
      const { verdict, transcript } = await runJudgement(metadata, audioPath, framePaths, status);
      await ctx.api.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {});
      await sendVerdict(ctx, metadata, verdict, transcript);
    });
  } catch (error) {
    await status.fail(error);
  }
});

async function runJudgement(
  metadata: ReelMetadata,
  audioPath: string,
  framePaths: string[],
  status: Status,
): Promise<{ verdict: Judgement; transcript: Transcript }> {
  status.step("Transcription");
  const transcript = await transcribe(audioPath);

  status.step("Jugement");
  const verdict = await judge(metadata, transcript, framePaths);

  record(metadata.shortcode, metadata.url, metadata.author, verdict, metadata.caption);
  return { verdict, transcript };
}

// Only `reply` is needed, and every message context exposes it identically — asking for
// the full text-message context here would reject photos and video files for no reason.
async function sendVerdict(
  ctx: Pick<TextContext, "reply">,
  metadata: ReelMetadata,
  v: Judgement,
  transcript: Transcript,
): Promise<void> {
  const yesNo = (b: boolean) => (b ? "OUI" : "non");
  const header =
    v.verdict === "COMMENTER"
      ? `<b>COMMENTER</b> · ${v.score}/100`
      : `<b>NE PAS COMMENTER</b> · ${v.score}/100`;

  const lines = [
    header,
    `Like : <b>${yesNo(v.like)}</b> · Republier : <b>${yesNo(v.republier)}</b>`,
  ];

  const age = ageInHours(metadata);
  if (age !== null) {
    const readable = age < 48 ? `${Math.round(age)} h` : `${Math.round(age / 24)} jours`;
    // Past a couple of days the comment section has settled and a new comment lands at
    // the bottom, where it will simply not be read.
    const warning = age > 48 ? " — trop vieux, ton commentaire naitra enterre" : "";
    lines.push(`Publie il y a <b>${readable}</b>${warning}`);
  }

  const density = commentDensity(metadata);
  if (density !== null) {
    const room = density < 1 ? "de la place" : density < 3 ? "assez dense" : "sature";
    lines.push(`${metadata.commentCount} commentaires · ${room}`);
  }

  lines.push(
    "",
    `<i>Cible</i> : ${escapeHtml(v.cible)}`,
    `<i>Douleur</i> : ${escapeHtml(v.douleur)}`,
    `<i>Pourquoi</i> : ${escapeHtml(v.pourquoi)}`,
  );

  if (v.verdict === "COMMENTER") {
    lines.push(`<i>Angle</i> : ${escapeHtml(v.angle)}`);
    lines.push(`<i>Risque</i> : ${v.risque} · <i>Mention marque</i> : ${yesNo(v.mentionMarque)}`);

    const already = commentsForAuthorToday(metadata.author);
    if (already > 1) {
      lines.push("", `Attention : ${already}e commentaire sur @${metadata.author} aujourd'hui.`);
    }
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });

  // The comment ships as its own message, with nothing around it: it lands last, closest
  // to the thumb, and a single tap on the block copies it with no stray text attached.
  if (v.verdict === "COMMENTER" && v.commentaire) {
    const sent = await ctx.reply(`<code>${escapeHtml(v.commentaire)}</code>`, {
      parse_mode: "HTML",
      reply_markup: REFINE_KEYBOARD,
    });

    // Kept in memory so a reformulation can be regenerated in context. Asking for one is
    // also the only feedback signal we collect: a comment left untouched was good enough.
    pending.set(sent.message_id, { metadata, transcript, comment: v.commentaire });
    if (pending.size > PENDING_LIMIT) {
      pending.delete(pending.keys().next().value!);
    }
  }

  // People in the comments who described the problem themselves are worth more than the
  // Reel's author: their need is active and stated.
  //
  // Everything goes in one message, each reply its own tap-to-copy block. And every block
  // opens with the @handle, so these are posted as top-level comments rather than threaded
  // replies: Instagram notifies the mention just the same, and you never have to hunt for
  // someone's comment in a section with hundreds of them.
  const prospects = v.prospects.slice(0, 3);
  if (prospects.length) {
    const blocks = prospects.map(
      (p) =>
        `<i>${escapeHtml(p.ceQuIlDit)}</i>\n` +
        `<code>@${escapeHtml(p.pseudo)} ${escapeHtml(p.reponse)}</code>`,
    );
    await ctx.reply(
      `<b>${prospects.length} personne${prospects.length > 1 ? "s" : ""} a qui repondre</b>\n\n` +
        blocks.join("\n\n"),
      { parse_mode: "HTML" },
    );
  }
}

async function downloadTelegramFile(fileId: string, filename = "input.mp4"): Promise<string> {
  const file = await bot.api.getFile(fileId);
  const response = await fetch(
    `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`,
  );
  if (!response.ok || !response.body) {
    throw new Error(`Telegram file download failed (${response.status})`);
  }

  const workDir = await mkdtemp(join(tmpdir(), "reel-copilot-tg-"));
  const filePath = join(workDir, filename);
  await streamPipeline(Readable.fromWeb(response.body), createWriteStream(filePath));
  return filePath;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

bot.catch((error) => console.error("Bot error:", error));

// bot.catch only covers handler failures. Polling errors reject start() instead, and
// Telegram allows exactly one getUpdates consumer per token: a second instance, or even
// a stray curl, evicts whoever was listening. Left unhandled that surfaces as a raw
// stack trace, so name the cause.
try {
  await bot.start({
    onStart: async () => {
      const ffmpeg = await isFfmpegAvailable();
      console.log(
        `reel-copilot is listening (ffmpeg: ${ffmpeg ? "yes" : "NO — video files and screenshots from Telegram will fail, Instagram links are unaffected"})`,
      );
    },
  });
} catch (error) {
  if (error instanceof GrammyError && error.error_code === 409) {
    console.error(
      "Stopped: another client is polling this bot token. Close the other instance " +
        "(and avoid calling getUpdates by hand) before restarting.",
    );
  } else {
    console.error("Stopped:", error);
  }
  process.exit(1);
}
