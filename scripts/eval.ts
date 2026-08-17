/**
 * Runs the judgement pass against fixed scenarios, without touching Instagram.
 *
 * Prompt changes are easy to make and hard to evaluate: a tweak that fixes one comment
 * often loosens a refusal somewhere else. The cases below are chosen so that several of
 * them SHOULD be refused. A run where everything is worth commenting on means the prompt
 * has stopped discriminating, which is the failure mode that matters here.
 *
 * Usage: npx tsx scripts/eval.ts
 */
import { judge } from "../src/pipeline/judge.js";
import type { ReelComment, ReelMetadata } from "../src/pipeline/scrape.js";
import type { Transcript } from "../src/pipeline/transcribe.js";

interface Scenario {
  name: string;
  /** What a careful human would decide, to compare against. */
  expected: "COMMENTER" | "NE_PAS_COMMENTER" | "borderline";
  why: string;
  caption: string;
  author: string;
  text: string;
  /** Hours since publication. Old Reels should be flagged even when relevant. */
  ageHours?: number;
  comments?: ReelComment[];
}

const SCENARIOS: Scenario[] = [
  {
    name: "coeur de cible",
    expected: "COMMENTER",
    why: "douleur exacte, audience exacte, angle naturel",
    author: "sarah.alternance",
    caption: "80 candidatures et toujours rien... #alternance #galere",
    text: "J'ai envoye 80 candidatures pour mon alternance en comptabilite depuis juin. Aucune reponse. Meme pas un refus. Je commence a me demander si mon CV part directement a la poubelle. Franchement je sais plus quoi faire.",
    ageHours: 3,
    comments: [
      { author: "lea.b_", text: "Moi c'est pareil avec mon stage, j'ai rien depuis mars", likeCount: 4, replyCount: 0, replies: [] },
      { author: "hugo.dev", text: "Courage 🔥🔥", likeCount: 0, replyCount: 0, replies: [] },
      { author: "manon_rh", text: "Tu as postule que sur les offres ou tu as contacte des boites directement ?", likeCount: 7, replyCount: 0, replies: [] },
      { author: "kev.2001", text: "Le probleme c'est le CV faut le refaire", likeCount: 2, replyCount: 0, replies: [] },
    ],
  },
  {
    name: "pertinent mais vieux",
    expected: "borderline",
    why: "sujet parfait, mais poste il y a 6 jours : le commentaire naitra enterre",
    author: "conseils.alternance",
    caption: "Comment j'ai trouve mon alternance en 3 semaines",
    text: "J'ai arrete de postuler aux annonces. J'ai fait une liste de vingt entreprises dans ma ville qui font mon metier, j'ai trouve le mail du responsable et je leur ai ecrit directement. Trois reponses, deux entretiens, une signature.",
    ageHours: 144,
    comments: [
      { author: "sofia.k", text: "Comment tu trouves les mails des responsables ?", likeCount: 12, replyCount: 0, replies: [] },
    ],
  },
  {
    name: "hors sujet total",
    expected: "NE_PAS_COMMENTER",
    why: "aucun rapport avec l'emploi",
    author: "cuisine.rapide",
    caption: "La recette de pates la plus rapide du monde",
    text: "Tu prends tes pates, tu les mets dans l'eau bouillante, pendant ce temps tu fais revenir de l'ail dans l'huile d'olive. Sept minutes et c'est pret.",
  },
  {
    name: "hors France",
    expected: "NE_PAS_COMMENTER",
    why: "sujet pertinent mais marche americain",
    author: "careergrowth.us",
    caption: "How I landed a job at Google",
    text: "So I applied to about forty companies in the Bay Area. What worked was reaching out to hiring managers on LinkedIn directly instead of using the careers page. Got three interviews that way.",
  },
  {
    name: "piege concurrentiel",
    expected: "borderline",
    why: "critique les outils d'automatisation, donc nous inclus",
    author: "recruteur.verite",
    caption: "Arretez avec les outils qui postulent pour vous",
    text: "Je recois trente candidatures par jour generees par IA. Toutes identiques. Le pire c'est quand la lettre parle d'une autre entreprise. Les candidats croient gagner du temps mais ils se grillent. Ces outils vous font plus de mal que de bien.",
  },
  {
    name: "piege RGPD",
    expected: "borderline",
    why: "sujet juridique, terrain glissant",
    author: "droit.travail",
    caption: "Ils n'ont pas le droit de garder ton CV",
    text: "Beaucoup d'entreprises gardent vos CV pendant des annees sans vous prevenir. C'est illegal. Le RGPD impose une duree de conservation limitee et vous avez le droit de demander la suppression.",
  },
  {
    name: "concurrent nomme",
    expected: "borderline",
    why: "tentation d'attaquer LinkedIn/Indeed",
    author: "job.tips.fr",
    caption: "Les 5 meilleurs sites pour trouver un job en France",
    text: "Numero un LinkedIn, numero deux Indeed, numero trois France Travail, numero quatre Welcome to the Jungle, numero cinq HelloWork. Postez votre CV sur les cinq et activez les alertes.",
  },
  {
    name: "cible mais rien a dire",
    expected: "NE_PAS_COMMENTER",
    why: "bonne audience, mais le Reel dit deja tout et ne laisse aucun angle",
    author: "etudiant.motive",
    caption: "J'ai signe mon alternance !!",
    text: "Ca y est j'ai signe. Merci a tous ceux qui m'ont soutenu pendant ces six mois de recherche. Je commence lundi. Croyez en vous.",
  },
  {
    name: "sans parole",
    expected: "borderline",
    why: "aucune transcription, tout est dans le visuel",
    author: "memes.etudiants",
    caption: "POV : tu ouvres ta boite mail apres 50 candidatures",
    text: "",
  },
];

function metadataFor(s: Scenario): ReelMetadata {
  const ageHours = s.ageHours ?? 4;
  return {
    shortcode: `eval-${s.name.replace(/\s+/g, "-")}`,
    url: "(evaluation)",
    videoUrl: "",
    audioUrl: null,
    displayUrl: null,
    caption: s.caption,
    author: s.author,
    durationSeconds: 30,
    viewCount: 50_000,
    likeCount: 3_000,
    hashtags: [...s.caption.matchAll(/#(\w+)/g)].map((m) => m[1] ?? ""),
    postedAt: new Date(Date.now() - ageHours * 3_600_000).toISOString(),
    commentCount: s.comments?.length ?? 0,
    commentsDisabled: false,
    comments: s.comments ?? [],
  };
}

function transcriptFor(s: Scenario): Transcript {
  return { text: s.text, language: s.name === "hors France" ? "en" : "fr", segments: [] };
}

const results = await Promise.all(
  SCENARIOS.map(async (s) => {
    try {
      return { s, verdict: await judge(metadataFor(s), transcriptFor(s), []) };
    } catch (error) {
      return { s, error: error instanceof Error ? error.message : String(error) };
    }
  }),
);

let agreements = 0;
let comparable = 0;

for (const { s, verdict, error } of results) {
  console.log("\n" + "=".repeat(72));
  console.log(`${s.name.toUpperCase()}  — attendu: ${s.expected}`);
  console.log(`(${s.why})`);
  if (error) {
    console.log(`ERREUR: ${error}`);
    continue;
  }
  if (!verdict) continue;

  const match = s.expected === "borderline" ? "-" : verdict.verdict === s.expected ? "OK" : "DIVERGE";
  if (s.expected !== "borderline") {
    comparable++;
    if (match === "OK") agreements++;
  }

  console.log(`\n>> ${verdict.verdict} ${verdict.score}/100  [${match}]`);
  console.log(`   like: ${verdict.like} | republier: ${verdict.republier} | risque: ${verdict.risque}`);
  if (verdict.commentaire) {
    console.log(`\n   "${verdict.commentaire}"`);
    console.log(`   (${verdict.commentaire.length} caracteres)`);
  }
  console.log(`\n   angle: ${verdict.angle}`);
  console.log(`   pourquoi: ${verdict.pourquoi}`);

  if (verdict.prospects.length) {
    console.log(`\n   PROSPECTS (${verdict.prospects.length}) :`);
    for (const p of verdict.prospects) {
      console.log(`   @${p.pseudo} — ${p.ceQuIlDit}`);
      console.log(`      "${p.reponse}"`);
    }
  }
}

console.log("\n" + "=".repeat(72));
console.log(`Accord sur les cas tranches : ${agreements}/${comparable}`);
