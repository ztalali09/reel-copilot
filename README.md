# reel-copilot

**A Telegram bot that watches an Instagram Reel, transcribes it, and drafts the one comment worth posting — or tells you to skip it.**

Share a Reel link with the bot. It pulls the audio, transcribes it with Whisper on Groq,
reads the cover frame and the existing comments, then hands back a judgement: engage or
skip, like or not, repost or not, and a single ready-to-paste comment. You post it
yourself.

Built in TypeScript on Node 22. Costs about **1.60 EUR per month** at twenty Reels a day.
Roughly **40 seconds** end to end per Reel.

---

## Why this exists

Commenting on other accounts still works as an organic growth channel, but it collapses
into noise the moment it is done at volume. Twenty generic comments a day get you an
action block and a reputation. Twenty *specific* comments a day require actually watching
twenty Reels, which nobody sustains for months.

This bot removes the watching, not the judgement. It reads the Reel so you do not have to,
and it argues for or against commenting on it. You stay the one who writes nothing you did
not approve and posts nothing automatically.

## This is not an automation tool

There is no auto-posting, no scheduler, no account credentials, no headless browser
driving your profile. **The bot never touches Instagram on your behalf.** It reads a
public Reel and forms an opinion.

That constraint drives the most important design decision here: **the bot is expected to
say "don't comment on this one."** A commenting assistant that approves everything turns
you into background noise. Refusing is a first-class output, not a failure case. In the
bundled test suite, several scenarios are ones it *should* refuse — and a run where
everything scores well means the prompt has stopped discriminating.

If you want something that sprays comments across a niche at scale, this is the wrong
repository. That approach earns an action block, and deservedly so.

## What you get back

For every Reel, two or more messages:

**1 — The judgement**

```
COMMENTER 87/100
Like : OUI · Republier : non
Publie il y a 4 h
27 commentaires · de la place

Cible : etudiants en recherche d'alternance
Douleur : beaucoup de candidatures, aucun retour
Pourquoi : ...
Risque : faible · Mention marque : non
```

**2 — The comment, alone, in a tap-to-copy block.** Nothing around it, so one tap puts it
in your clipboard with no stray text attached.

**3 — Prospects (when there are any).** People in the comment section who just described
your problem out loud: someone asking a question nobody answered, someone saying "same
here". One message each, with a suggested reply. These are often worth more than the Reel
itself — their need is active and stated.

It also refuses early, before spending a cent, when comments are disabled or when you have
already commented on that Reel (it shows you what you wrote and how many likes it got).

## Signals it weighs

Beyond relevance, which is the obvious part:

- **Age.** Past 48 hours the comment section has settled and a new comment is born buried.
  Score is capped at 65, then 45 after a week.
- **Crowding.** A moderately relevant Reel with twelve comments gives you more visibility
  than a perfect one under eight hundred. Relevance decides whether you have something to
  say; crowding decides whether anyone reads it.
- **What has already been said.** Existing comments go into the prompt, so it does not
  hand you an idea someone already posted.

## How it works

```
you share a Reel link  ->  Telegram bot
      |
      1. Apify        metadata, caption, comments, separate audio URL
      2. download     audio track + cover image  (a few hundred KB)
      3. Groq         transcription, whisper-large-v3-turbo
      4. Gemini       judgement, from transcript + cover + comments
      |
      <-  engage / skip · like · repost · one comment · prospects
```

Send a **video file** or a **screenshot** instead of a link and the scraping step is
skipped entirely — useful for trying the judgement without spending scraper credits, or
for reacting to something you just captured while scrolling.

## Cost

| Service | Role | Cost at 20 Reels/day |
|---|---|---|
| **Groq** | transcription | **free** — the free tier covers 8 hours of audio per day |
| **Gemini** | judgement | negligible |
| **Apify** | resolving the Reel | ~1.60 EUR/month, inside the free plan's monthly credit |

The free tiers genuinely cover this workload. Transcription is not the expensive part of
this problem — getting at the media is.

## Two things that make it fast and cheap

These cost real debugging time, so they are written down.

### Instagram exposes the audio track separately

Do **not** download the video. Apify returns an `audioUrl` alongside `videoUrl`, and it is
about twenty times smaller. Measured on the same 44-second Reel:

| | Size | Time |
|---|---|---|
| Full video | several MB | minutes |
| **`audioUrl`** | **284 KB** | **2.5 s** |

Groq accepts `.m4a` directly, so ffmpeg leaves the critical path too. Pair it with
`displayUrl` — the cover image, which is where the hook text usually lives — and you have
everything the judgement needs.

### Node's `fetch` hangs on Instagram's CDN

`scontent-*.cdninstagram.com` publishes both A and AAAA records, and its IPv6 addresses
are unroutable from many networks. Node's `fetch` keeps trying IPv6 and fails with an
opaque `fetch failed (ETIMEDOUT)` that comes and goes depending on which CDN host DNS
hands back. `curl` hides this by falling back to IPv4 in milliseconds.

**`dns.setDefaultResultOrder("ipv4first")` does not fix it** — undici ignores it. Measured
on the same URL in the same second:

| Method | Result |
|---|---|
| `fetch` | ETIMEDOUT |
| `fetch` + browser User-Agent | ETIMEDOUT |
| **`https.get` with `family: 4`** | **200, 284 616 bytes in 2.9 s** |

So this project uses `https.get` with an explicit IPv4 family, plus redirect handling and
retries. See `openIPv4` in [`src/pipeline/scrape.ts`](src/pipeline/scrape.ts).

## Your criteria, not mine

The judgement is driven by a `context/brand.md` file that you write and that Git ignores.
It holds your positioning, your audience, your tone rules and your hard prohibitions, and
it is injected verbatim into every judgement. See [`context/README.md`](context/README.md).

The audience definition is what earns you honest refusals. Without a precise one the model
has no ground to stand on when it says "this Reel is not for you", and it will approve
everything. That one paragraph does more for output quality than any prompt tuning.

## Evaluating prompt changes

Prompt edits are easy to make and hard to evaluate: a tweak that fixes one comment quietly
loosens a refusal somewhere else.

```bash
npx tsx scripts/eval.ts
```

Runs the judgement against fixed scenarios — a perfect match, an off-topic Reel, a
non-French one, a celebration post, a Reel hostile to your own category, one with no
speech — and reports where it agrees with the expected verdict. Several cases are meant to
be refused.

## Quick start

Requires **Node 22+** and ffmpeg (only for video files sent to Telegram; Instagram links
do not need it).

```bash
git clone https://github.com/ztalali09/reel-copilot.git
cd reel-copilot
npm install
cp .env.example .env    # fill it in
```

You need four keys, all free to obtain:

| Variable | Where |
|---|---|
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) → `/newbot` |
| `TELEGRAM_OWNER_ID` | [@userinfobot](https://t.me/userinfobot) → `/start` |
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) — free, no card |
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `APIFY_TOKEN` | [apify.com](https://apify.com) → Settings → Integrations |

Then write your `context/brand.md`, and:

```bash
npm start
```

The bot answers only `TELEGRAM_OWNER_ID`. Anything from another account is dropped before
it costs a request.

## Deploying

It runs anywhere Node runs. On **Railway**:

```bash
npx @railway/cli init --name reel-copilot
npx @railway/cli volume add --mount-path /data      # keeps the SQLite history
npx @railway/cli variables --service reel-copilot \
  --set "DATA_DIR=/data" \
  --set "BRAND_CONTEXT_B64=$(base64 -w0 context/brand.md)" \
  --set "RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg"
npx @railway/cli up --service reel-copilot --detach
```

Notes worth knowing:

- Railway now builds with **railpack**, which ignores `nixpacks.toml`. Extra system
  packages go through `RAILPACK_DEPLOY_APT_PACKAGES`.
- `context/brand.md` is git-ignored, so it travels as `BRAND_CONTEXT_B64`. Re-set that
  variable whenever you edit the brief.
- **Telegram allows one `getUpdates` consumer per token.** Never run a local instance
  while a hosted one is live — one of the two dies with a 409.

## Commands

| | |
|---|---|
| `/ping` | answers instantly, and says how many Reels are in flight |
| `/stats` | how many Reels judged today, and how many are worth commenting on |

Send several links in one message and they queue, two at a time — pacing set by Gemini's
free-tier limit of roughly ten requests per minute.

## Stack

TypeScript · Node 22 · [grammY](https://grammy.dev) · Groq (whisper-large-v3-turbo) ·
Google Gemini 2.5 Flash · Apify · SQLite (better-sqlite3)

## Author

**Zakaria Talali** — [github.com/ztalali09](https://github.com/ztalali09)

Built while running [Jobea](https://jobea.fr), a French job-search product, where the
problem was concrete: show up usefully in a niche every day, without a face on camera and
without becoming the account that comments on everything.

## Licence

MIT
