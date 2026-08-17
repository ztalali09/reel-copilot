import { GoogleGenAI, Type } from "@google/genai";
import { readFile } from "node:fs/promises";
import { config } from "../config.js";
import { ageInHours, commentDensity, type ReelMetadata } from "./scrape.js";
import type { Transcript } from "./transcribe.js";

const BRAND_CONTEXT_PATH = new URL("../../context/brand.md", import.meta.url);

export interface Judgement {
  verdict: "COMMENTER" | "NE_PAS_COMMENTER";
  score: number;
  like: boolean;
  republier: boolean;
  cible: string;
  douleur: string;
  angle: string;
  /** Empty when the verdict is NE_PAS_COMMENTER: no comment is fabricated. */
  commentaire: string;
  pourquoi: string;
  risque: "faible" | "moyen" | "eleve";
  mentionMarque: boolean;
  /** People in the comments who just declared the problem the brand solves. */
  prospects: Prospect[];
}

export interface Prospect {
  pseudo: string;
  ceQuIlDit: string;
  reponse: string;
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    verdict: { type: Type.STRING, enum: ["COMMENTER", "NE_PAS_COMMENTER"] },
    score: { type: Type.INTEGER, description: "0-100, pondere selon la grille de scoring" },
    like: { type: Type.BOOLEAN, description: "Liker ce Reel depuis le compte de marque ?" },
    republier: { type: Type.BOOLEAN, description: "Republier en story ?" },
    cible: { type: Type.STRING, description: "Qui regarde reellement ce Reel" },
    douleur: { type: Type.STRING, description: "La douleur identifiee, ou 'aucune'" },
    angle: { type: Type.STRING, description: "L'angle retenu, ou pourquoi aucun ne tient" },
    commentaire: {
      type: Type.STRING,
      description: "LE commentaire, pret a copier-coller. Chaine vide si NE_PAS_COMMENTER.",
    },
    pourquoi: { type: Type.STRING, description: "Une phrase justifiant le verdict" },
    risque: { type: Type.STRING, enum: ["faible", "moyen", "eleve"] },
    mentionMarque: { type: Type.BOOLEAN },
    prospects: {
      type: Type.ARRAY,
      description: "Commentateurs exprimant la douleur. Vide si aucun. Trois au maximum.",
      items: {
        type: Type.OBJECT,
        properties: {
          pseudo: { type: Type.STRING },
          ceQuIlDit: { type: Type.STRING, description: "Sa douleur, resumee en quelques mots" },
          reponse: { type: Type.STRING, description: "Reponse courte a lui adresser" },
        },
        required: ["pseudo", "ceQuIlDit", "reponse"],
      },
    },
  },
  required: [
    "verdict", "score", "like", "republier", "cible", "douleur",
    "angle", "commentaire", "pourquoi", "risque", "mentionMarque", "prospects",
  ],
} as const;

const INSTRUCTIONS = `
Tu appliques le contexte de marque ci-dessus a UN Reel Instagram.

Ta sortie n'est pas une suggestion : elle est copiee-collee telle quelle par un humain qui
publiera depuis le compte de la marque. Ecris donc le commentaire final, pas un brouillon.

REGLES DE DECISION

1. NE_PAS_COMMENTER est un verdict normal et attendu, pas un echec. Le refus est meilleur
   qu'un commentaire force. Si aucun angle naturel n'existe, refuse et laisse le champ
   commentaire vide. Ne fabrique jamais une proposition pour remplir la reponse.
2. Un seul commentaire. Pas d'alternatives, pas de variantes : celui que tu proposes est
   celui que tu juges le meilleur, et tu l'assumes.
3. Applique la grille de scoring pour calculer le score. Sous 55, le verdict est
   NE_PAS_COMMENTER sauf angle reellement exceptionnel, que tu dois alors justifier.
4. LIKE et REPUBLIER se decident independamment du commentaire. Un Reel peut meriter un
   like sans meriter un commentaire. Ne recommande REPUBLIER que si le contenu sert
   directement l'audience de la marque et qu'on l'assume publiquement : republier, c'est
   endosser.
5. Passe le commentaire par la checklist avant de le rendre. S'il pourrait etre poste sous
   cent autres videos, il est mauvais : recommence ou refuse.
6. Le commentaire doit appartenir a la conversation du Reel avant d'appartenir a la marque.
   Il se lit comme un vrai commentaire humain, court, une idee.

FORME DU COMMENTAIRE — ces regles sont dures

- UNE phrase. Deux au maximum, et seulement si la seconde est tres courte. Jamais trois.
  Vise 120 caracteres. Un commentaire long se lit comme un article, pas comme quelqu'un
  qui reagit.
- OBSERVE, NE CONSEILLE PAS. Reformule ce que la video montre avec une precision que son
  auteur n'a pas formulee. N'explique pas a l'audience ce qu'elle devrait faire : elle
  n'a rien demande, et le ton donneur de lecons tue le commentaire.
- N'ouvre jamais par un acquiescement : "Exactement", "Tellement vrai", "C'est ca",
  "Carrement", "100%". Ces ouvertures pourraient preceder n'importe quel commentaire sous
  n'importe quelle video : elles prouvent a elles seules que le commentaire est generique.
- Pas de flatterie ajoutee ("bien joue", "bravo", "trop fort"). Elle ne dit rien et se voit.
- Pas de formule creuse ("c'est la cle", "le secret", "ca change tout", "il faut savoir").
- Le commentaire doit pouvoir se lire comme celui d'une personne qui a regarde la video,
  pas d'une marque qui a compris une opportunite.

LES COMMENTAIRES DEJA PRESENTS

On te donne les commentaires deja publies sous le Reel. Ils servent a deux choses.

1. NE REPETE PAS ce qui a deja ete dit. Si quelqu'un a formule ton idee, la reprendre te
   fait passer pour l'enieme personne qui n'a pas lu. Trouve autre chose, ou refuse.
2. REPERE LES PROSPECTS. Certains commentateurs decrivent eux-memes le probleme que
   resout la marque : ils galerent, ils posent une question restee sans reponse, ils
   racontent la meme situation. Ce sont les gens les plus interessants du Reel, bien plus
   que son auteur, parce que leur besoin est actif et declare.

   Remplis 'prospects' avec au maximum trois d'entre eux : leur pseudo, ce qu'ils disent,
   et une reponse courte a leur adresser. La reponse s'adresse a la PERSONNE, pas a
   l'audience : elle repond a ce qu'elle a ecrit, sans pitch, comme quelqu'un qui aide.

   ORDRE DE PRIORITE, il compte :
   a) Une QUESTION restee sans reponse. C'est la meilleure occasion qui existe : quelqu'un
      demande publiquement, personne ne repond, et tu sais repondre. Ne la rate jamais.
   b) Un commentaire tres like : il est lu par tous ceux qui ouvrent la section.
   c) Une situation vecue et decrite precisement.
   d) En dernier, une plainte generale ("moi aussi je galere") : elle n'appelle pas de
      reponse utile, et y repondre produit du vide poli.

   Les reponses aux prospects obeissent AUX MEMES REGLES DE FORME que le commentaire
   principal. Pas de "Courage !", pas de "Bonne chance", pas de banalite encourageante :
   ces phrases ne disent rien et se voient. Si tu n'as rien d'utile a repondre a quelqu'un,
   ne le retiens pas comme prospect.

   Laisse 'prospects' vide si personne ne s'y prete. N'invente jamais un pseudo, et ne
   retiens jamais le compte de la marque elle-meme.

LE BUT REEL DU COMMENTAIRE

Le commentaire ne s'adresse PAS a l'auteur du Reel. Il s'adresse aux gens qui lisent les
commentaires, c'est-a-dire a ceux qui vivent le probleme assez fort pour chercher si
quelqu'un a dit quelque chose d'intelligent.

Le test final, avant de rendre un commentaire : est-ce qu'un lecteur se demanderait QUI a
ecrit ca ? Un commentaire juste, poli et banal est un echec complet. Il ne choque
personne et n'interesse personne. Mieux vaut refuser que produire du tiede.

LES EXEMPLES NE SONT PAS UN CATALOGUE

Les commentaires donnes en exemple dans le contexte de marque illustrent une METHODE.
Ne les reutilise jamais tels quels, ni en les paraphrasant de pres. Si ta proposition
ressemble a l'un d'eux, c'est le signe que tu as pioche au lieu d'observer : reviens au
Reel et repars de ce qu'il montre de particulier.

CAS QUI DEMANDENT UNE RETENUE PARTICULIERE

- CELEBRATION. Quand quelqu'un annonce une bonne nouvelle (contrat signe, alternance
  trouvee, entretien decroche), on felicite sobrement ou on se tait. Placer un angle
  produit sur la reussite de quelqu'un est le comportement de la marque qui recupere
  tout, et ca se voit immediatement. Dans le doute : NE_PAS_COMMENTER.
- CONTENU HOSTILE A LA CATEGORIE. Quand un Reel critique les outils d'automatisation de
  candidature, tout commentaire de notre part se lit comme de l'auto-defense, meme
  nuance. Le gain est faible et le risque eleve : refuse, sauf si tu peux repondre sans
  jamais defendre l'outillage.
- SUJET JURIDIQUE. Rester factuel ou se taire. Jamais d'interpretation.

LE LIKE N'EST PAS GRATUIT

Liker est un signal public et un signal a l'algorithme. Ne like pas par defaut. Like
seulement si le contenu sert vraiment l'audience de la marque ET que tu assumes d'y etre
associe. Un Reel hors cible ne se like pas, meme s'il est bon.

CALIBRAGE DU SCORE

Sois severe. 100 signifie qu'aucun meilleur Reel n'existe pour cette marque, ce qui
n'arrive presque jamais : au-dessus de 90, demande-toi ce qui manquerait pour 100 et
descends. La plupart des Reels pertinents se situent entre 60 et 85.

Le score mesure l'OPPORTUNITE REELLE, pas seulement la pertinence du sujet. Deux faits
la reduisent, meme sur un Reel parfait :

- L'AGE. Passe 48 h, la section commentaires est figee et un nouveau commentaire arrive
  tout en bas, ou personne ne le lira. Plafonne alors le score a 65 et dis-le dans
  'pourquoi'. Au-dela d'une semaine, plafonne a 45.
- L'ENCOMBREMENT. Sous des centaines de commentaires, le tien est invisible quoi qu'il
  dise. A l'inverse, une section peu remplie sur un Reel bien vu est une occasion rare :
  c'est un point en faveur, meme si le sujet n'est que moyennement pertinent.

Quand il n'y a pas de transcription, juge sur ce que tu vois REELLEMENT. Une capture
d'ecran ou une image de couverture qui porte le texte du Reel est une information
suffisante : lis-la et traite-la comme telle. En revanche, si l'image ne montre rien
d'exploitable et que la legende est pauvre, tu juges sur presque rien : plafonne alors le
score a 70, dis-le dans 'pourquoi', et refuse plutot que d'inventer un contenu plausible.
7. Ne t'appuie que sur ce que tu observes reellement dans la transcription, la legende et
   les images. Si la transcription est vide, dis-le dans 'pourquoi' plutot que de deviner
   le contenu.
`.trim();

let brandContext: string | null = null;

async function loadBrandContext(): Promise<string> {
  if (brandContext !== null) return brandContext;

  // On a host, the brand brief travels as an environment variable rather than a file:
  // it holds positioning we deliberately keep out of the repository. Base64 is offered
  // because the brief is thousands of characters of multi-line Markdown, which survives
  // neither a shell argument nor most dashboard fields intact.
  const encoded = process.env.BRAND_CONTEXT_B64?.trim();
  if (encoded) {
    brandContext = Buffer.from(encoded, "base64").toString("utf8");
    return brandContext;
  }

  const fromEnv = process.env.BRAND_CONTEXT?.trim();
  if (fromEnv) {
    brandContext = fromEnv;
    return brandContext;
  }

  try {
    brandContext = await readFile(BRAND_CONTEXT_PATH, "utf8");
  } catch {
    throw new Error(
      "No brand context. Provide context/brand.md locally, or set BRAND_CONTEXT when hosted. " +
        "See context/README.md.",
    );
  }
  return brandContext;
}

export async function judge(
  metadata: ReelMetadata,
  transcript: Transcript,
  framePaths: string[],
): Promise<Judgement> {
  const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  const brand = await loadBrandContext();

  const frames = await Promise.all(
    framePaths.map(async (path) => ({
      inlineData: {
        mimeType: "image/jpeg",
        data: (await readFile(path)).toString("base64"),
      },
    })),
  );

  const age = ageInHours(metadata);
  const density = commentDensity(metadata);

  const reelBrief = [
    `AUTEUR : ${metadata.author ?? "inconnu"}`,
    `LEGENDE : ${metadata.caption || "(aucune)"}`,
    metadata.hashtags.length ? `HASHTAGS : ${metadata.hashtags.join(", ")}` : "",
    `VUES : ${metadata.viewCount ?? "inconnu"} | LIKES : ${metadata.likeCount ?? "inconnu"}`,
    age === null
      ? "PUBLIE : date inconnue"
      : `PUBLIE IL Y A : ${age < 48 ? `${Math.round(age)} h` : `${Math.round(age / 24)} jours`}`,
    `COMMENTAIRES : ${metadata.commentCount ?? "inconnu"}${
      density === null ? "" : ` (${density.toFixed(2)} pour 1000 vues)`
    }`,
    `LANGUE DETECTEE : ${transcript.language}`,
    "",
    "TRANSCRIPTION :",
    transcript.text || "(aucune parole detectee dans ce Reel)",
    "",
    "COMMENTAIRES DEJA PUBLIES :",
    metadata.comments.length
      ? metadata.comments
          .map((c) => `@${c.author ?? "?"} (${c.likeCount} likes) : ${c.text}`)
          .join("\n")
      : "(aucun commentaire recupere)",
  ]
    .filter(Boolean)
    .join("\n");

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { text: brand },
          { text: INSTRUCTIONS },
          { text: reelBrief },
          // Frames last: a lot of Reels carry their real message in burned-in text.
          { text: "IMAGES EXTRAITES DU REEL :" },
          ...frames,
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      // The judgement should be stable: the same Reel twice should not flip verdicts.
      temperature: 0.4,
    },
  });

  const raw = response.text;
  if (!raw) throw new Error("Gemini returned an empty judgement");

  const parsed = JSON.parse(raw) as Judgement;

  // The schema cannot express "empty comment when refusing", so enforce it here.
  if (parsed.verdict === "NE_PAS_COMMENTER") parsed.commentaire = "";

  return parsed;
}
