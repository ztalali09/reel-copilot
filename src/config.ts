import { setDefaultResultOrder } from "node:dns";

// Instagram's CDN publishes both A and AAAA records, but its IPv6 addresses are
// unreachable from many networks. Node then opens an IPv6 socket and waits for the full
// timeout, which surfaces as an opaque "fetch failed (ETIMEDOUT)" that comes and goes
// depending on which CDN host the DNS hands back. curl hides this by falling back to
// IPv4 in milliseconds; we have to ask for it explicitly.
setDefaultResultOrder("ipv4first");

// Node 22 reads .env natively, so no dotenv dependency. A missing file is fine:
// the process may be configured through real environment variables instead.
try {
  process.loadEnvFile();
} catch {
  // no .env on disk
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

export const config = {
  telegram: {
    token: required("TELEGRAM_BOT_TOKEN"),
    // Single-user bot. Anyone else who finds it gets ignored.
    ownerId: Number(required("TELEGRAM_OWNER_ID")),
  },
  groq: {
    apiKey: required("GROQ_API_KEY"),
    // Turbo is 0.04 USD/hour against 0.111 for the full model, and the accuracy
    // difference does not show on 30-second Reels.
    model: "whisper-large-v3-turbo",
  },
  gemini: {
    apiKey: required("GEMINI_API_KEY"),
  },
  apify: {
    token: required("APIFY_TOKEN"),
  },
  brand: {
    // Used to spot that we already commented on a Reel before proposing another one.
    instagramHandle: process.env.BRAND_INSTAGRAM_HANDLE?.replace(/^@/, "").toLowerCase() ?? null,
  },
} as const;
