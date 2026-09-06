// Which language is this book actually written in?
//
// The library is English. A file that isn't — a wrong-edition download, a
// translation grabbed by mistake — is invisible to every other health check:
// it unzips, its spine resolves, it has plenty of prose and a full TOC, and
// it reads as a perfectly healthy book right up until you open it on the
// device. So the checker measures the language of the TEXT and compares it
// with what the file CLAIMS (dc:language), which is the only way either half
// of that disagreement can surface.
//
// 🔴 It is also the gate on health.ts's English-only OCR signals, and that is
// the sharper reason it exists. Those signals used to be gated on the
// DECLARED tag, which is exactly the thing a mislabelled file gets wrong: a
// Spanish novel tagged `en` lights up "stray single letters" on every "y" and
// "o" in the book, and an English novel tagged `de` silently skips the scanno
// list that would have caught its OCR damage. Measured beats declared;
// declared is only the fallback when there isn't enough text to measure.
//
// 🔴 Pure in the stats.ts / pages.ts sense: no DB, no fs, no clock, and it
// imports NOTHING — bytes of text in, verdict out — so the gate drives the
// real module with real prose, and nothing heavy rides into a client bundle
// behind it.
//
// HOW IT MEASURES, and why this method rather than a dependency: the share of
// tokens that are FUNCTION WORDS (the, of, and / le, la, des / der, die, und).
// Function words are the most frequent words in any language, they are
// closed-class so the list can't go stale, and their share of a text is
// remarkably stable across authors, centuries and genres — real English prose
// runs roughly 40–60% (measured on the gate's passages), and a text in any
// other language runs near zero on the English list because the overlap
// between two languages' function words is tiny. n-gram model files or a
// language-detection package would be more precise on a single sentence and
// buy nothing here: a book is thousands of words, where this is decisive.
//
// 🔴 What it deliberately WON'T do: guess on thin evidence. Under
// MIN_WORDS_FOR_VERDICT there is no verdict at all (`isEnglish: null`), and
// there is a middle band — some English function words but not a prose-like
// share, and no other language winning — that also returns null rather than
// an accusation. A book of tables, code listings or heavily damaged text
// lands there, and "can't tell" is the honest answer for it.
//
// Known limit, stated rather than smoothed: a bilingual or heavily quoted
// book is scored on its dominant language, and a translated book whose front
// matter is English is still measured over the whole text (the sample is
// strided across it, not taken from the front, precisely so a copyright page
// can't outvote the novel).

export type LanguageCode = "en" | "fr" | "de" | "es" | "it" | "pt" | "nl";

export type LanguageVerdict = {
  /** true / false / null when there is not enough evidence to say. */
  isEnglish: boolean | null;
  /** The best-scoring known language, or null when none scored. */
  code: LanguageCode | null;
  /** Display name for `code`, or the dominant non-Latin script's name. */
  name: string | null;
  /** Share of sampled tokens that are English function words, 0..1. */
  englishRate: number;
  /** Share for the winning language (=== englishRate when English wins). */
  bestRate: number;
  /** Tokens actually scored. */
  words: number;
  /** Set when the text is predominantly a non-Latin script. */
  script: string | null;
};

/** Below this many words there is no verdict — never an accusation off a
 *  page and a half of text. */
export const MIN_WORDS_FOR_VERDICT = 200;
/** English prose sits far above this; the gate's real passages measure
 *  40–60%. Below it, English is not confirmed. */
export const ENGLISH_MIN_RATE = 0.2;
/** Another language must clear this AND beat English by MARGIN to win. */
const OTHER_MIN_RATE = 0.12;
/** 🔴 The margin is what buys the honest 'can't tell'. A book that is half
 *  English and half something else scores both languages in the high 20s,
 *  and whichever edges ahead is a coin toss — measured on a 40/60 English /
 *  Dutch mix, the two rates come out 25.0% and 26.3%, a ratio of 1.05. With
 *  the margin that book gets NO verdict; without it, it is confidently
 *  declared Dutch. check:books:health pins the mixed case for this reason.
 */
const MARGIN = 1.5;
/** Rate below which "this is not English prose" is safe to say even when no
 *  known language wins (a real English book never comes close). */
const ENGLISH_IMPLAUSIBLE_RATE = 0.06;
/** Cost bound: a rate converges long before this, and it keeps a 500k-word
 *  omnibus the same work as a novel. Sampling is STRIDED, not head-first. */
const MAX_SAMPLE_WORDS = 30_000;
/** Share of letters that must be Latin before the function-word stage is
 *  meaningful at all. */
const LATIN_MIN_SHARE = 0.6;

export const LANGUAGE_NAMES: Record<LanguageCode, string> = {
  en: "English",
  fr: "French",
  de: "German",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
};

// Function words: the closed-class, highest-frequency words of each language.
// Overlap between lists ("a", "in", "no", "so", "was") is expected and
// harmless — the verdict is an argmax with a margin, not a single-word test.
const FUNCTION_WORDS: Record<LanguageCode, string[]> = {
  en: `the of and to a in that is was it for with as his on be at by this had not are but from or have
    an they which one you were her all she there would their we him been has when who will more no if
    out so said what up its about into than them can only other could my then do first very any now
    made over did down way because through before after where most these some such much must should
    might upon shall him himself herself them our your me`.split(/\s+/),
  fr: `le la les de des du un une et à il elle je ne pas que qui dans pour sur est sont était avec ce
    cette se son sa ses nous vous ils mais plus tout tous par comme ou où en aux au lui leur leurs
    avait avoir être fait bien très dit quand si me te moi toi cela cet ces dont chez sans sous deux
    encore alors même aussi donc puis on ont j'ai n'est c'est qu'il`.split(/\s+/),
  de: `der die das und den dem des ein eine einen einem einer eines ist sind war waren nicht sich mit
    auf für von zu zum zur im in an als auch es er sie wir ihr aber oder wenn dass daß dann noch nur
    wie wer man hat hatte haben werden wurde wird sein seine seinen seiner ich du mir mich dir dich
    uns euch bei nach über unter vor durch um doch schon immer mehr sehr alle alles`.split(/\s+/),
  es: `el la los las de del un una unos unas y o que en con por para no se su sus es son era fue ha han
    había muy más pero como cuando donde quien este esta esto ese esa eso aquel al lo le les me te nos
    yo él ella ellos ellas todo todos toda también ya sin sobre entre hasta desde porque así bien
    aunque mientras había ser estaba tenía`.split(/\s+/),
  it: `il lo la i gli le di del della dei delle un una uno e ed che in con per non si sono è era ha
    aveva ma come quando dove chi questo questa quello quella al alla ai alle da dal dalla su sul sulla
    anche più molto tutto tutti se mi ti ci vi loro suo sua io lui lei noi voi però già ancora poi così
    senza tra fra nel nella`.split(/\s+/),
  pt: `o a os as de do da dos das um uma uns umas e que em no na nos nas com por para não se seu sua é
    são era foi tem têm tinha mas como quando onde quem este esta esse essa isso ao à aos às lhe lhes
    me te nós eu ele ela eles elas todo todos também já sem sobre entre até desde porque assim muito
    mais pelo pela`.split(/\s+/),
  nl: `de het een en van in is zijn was waren niet met op voor aan door om dat die dit deze te ze zij
    hij ik we wij jij maar of als ook er naar uit bij over onder tussen nog wel geen veel meer heel zo
    dan toen want omdat worden werd heeft hebben had hadden kan kunnen zou zouden hem haar mij`.split(
    /\s+/,
  ),
};

const WORD_SETS = new Map<LanguageCode, Set<string>>(
  (Object.keys(FUNCTION_WORDS) as LanguageCode[]).map((c) => [c, new Set(FUNCTION_WORDS[c])]),
);

// Non-Latin scripts worth naming: a book in one of these is not English and
// the function-word stage would report a meaningless 0%.
const SCRIPTS: Array<{ name: string; test: (c: number) => boolean }> = [
  { name: "Cyrillic", test: (c) => c >= 0x0400 && c <= 0x04ff },
  { name: "Greek", test: (c) => c >= 0x0370 && c <= 0x03ff },
  { name: "Hebrew", test: (c) => c >= 0x0590 && c <= 0x05ff },
  { name: "Arabic", test: (c) => (c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f) },
  { name: "Devanagari", test: (c) => c >= 0x0900 && c <= 0x097f },
  { name: "Japanese kana", test: (c) => c >= 0x3040 && c <= 0x30ff },
  { name: "Han (Chinese/Japanese)", test: (c) => c >= 0x4e00 && c <= 0x9fff },
  { name: "Hangul", test: (c) => c >= 0xac00 && c <= 0xd7af },
  { name: "Thai", test: (c) => c >= 0x0e00 && c <= 0x0e7f },
];

function isLatinLetter(c: number): boolean {
  return (
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    (c >= 0xc0 && c <= 0x24f) // Latin-1 supplement + extended A/B
  );
}

/**
 * Words, lowercased, stripped of surrounding punctuation. Diacritics are
 * PRESERVED, unlike the catch-up phrase search, which folds them because a
 * heard phrase has no spelling.
 *
 * Measured, so the comment does not overclaim: folding them costs 0.2–3.1
 * points of the winner's rate (French 41.7% → 39.4% is the worst) and
 * changes NO verdict on the gate's eleven real books. Keeping them is free
 * and slightly sharpens the signal; the answer does not depend on it.
 */
export function tokenizeWords(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\s+/)) {
    if (!raw) continue;
    const bare = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
    if (bare) out.push(bare);
  }
  return out;
}

/** Every `stride`-th token, so the sample spans the whole book rather than
 *  its front matter (which is often English even in a translation). */
function sample(tokens: string[]): string[] {
  if (tokens.length <= MAX_SAMPLE_WORDS) return tokens;
  const stride = Math.ceil(tokens.length / MAX_SAMPLE_WORDS);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += stride) out.push(tokens[i]);
  return out;
}

function dominantScript(tokens: string[]): { name: string; share: number } | null {
  const counts = new Map<string, number>();
  let latin = 0;
  let letters = 0;
  for (const tok of tokens) {
    for (const ch of tok) {
      const c = ch.codePointAt(0)!;
      if (isLatinLetter(c)) {
        latin++;
        letters++;
        continue;
      }
      const s = SCRIPTS.find((s) => s.test(c));
      if (s) {
        counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
        letters++;
      }
    }
  }
  if (letters === 0) return null;
  if (latin / letters >= LATIN_MIN_SHARE) return null;
  let best: { name: string; share: number } | null = null;
  for (const [name, n] of counts) {
    const share = n / letters;
    if (!best || share > best.share) best = { name, share };
  }
  return best;
}

/**
 * The verdict. Takes tokens (from `tokenizeWords`) so a caller that already
 * walked the text — health.ts does, for its OCR signals — pays for one pass.
 */
export function detectLanguage(allTokens: string[]): LanguageVerdict {
  const tokens = sample(allTokens);
  const words = tokens.length;
  const empty: LanguageVerdict = {
    isEnglish: null,
    code: null,
    name: null,
    englishRate: 0,
    bestRate: 0,
    words,
    script: null,
  };
  if (words < MIN_WORDS_FOR_VERDICT) return empty;

  const script = dominantScript(tokens);
  if (script) {
    return { ...empty, isEnglish: false, name: script.name, script: script.name };
  }

  const hits = new Map<LanguageCode, number>();
  for (const tok of tokens) {
    for (const [code, set] of WORD_SETS) {
      if (set.has(tok)) hits.set(code, (hits.get(code) ?? 0) + 1);
    }
  }

  const englishRate = (hits.get("en") ?? 0) / words;
  let bestCode: LanguageCode = "en";
  let bestRate = englishRate;
  for (const [code, n] of hits) {
    const rate = n / words;
    if (rate > bestRate) {
      bestCode = code;
      bestRate = rate;
    }
  }

  // English wins outright.
  if (bestCode === "en" && englishRate >= ENGLISH_MIN_RATE) {
    return { isEnglish: true, code: "en", name: LANGUAGE_NAMES.en, englishRate, bestRate, words, script: null };
  }
  // Another language wins outright: it clears its own floor AND beats English
  // by a clear margin. Both halves matter — a low-scoring winner is noise,
  // and a winner that barely edges English out is a coin toss.
  if (bestCode !== "en" && bestRate >= OTHER_MIN_RATE && bestRate >= englishRate * MARGIN) {
    return {
      isEnglish: false,
      code: bestCode,
      name: LANGUAGE_NAMES[bestCode],
      englishRate,
      bestRate,
      words,
      script: null,
    };
  }
  // Nothing won, but English is implausibly low for English prose: say that
  // much and no more — we cannot name what it is.
  if (englishRate < ENGLISH_IMPLAUSIBLE_RATE) {
    return { isEnglish: false, code: null, name: null, englishRate, bestRate, words, script: null };
  }
  // The honest middle: some English, not a prose-like share, nothing else
  // winning. No verdict.
  return { ...empty, englishRate, bestRate };
}

// dc:language may be ISO 639-1 or 639-2, with a region ("en-GB", "pt_BR").
// Only the languages this check can actually MEASURE are mapped — an
// unrecognised tag yields null, and null never becomes an accusation.
const TAG_ALIASES: Record<string, LanguageCode> = {
  en: "en", eng: "en",
  fr: "fr", fre: "fr", fra: "fr",
  de: "de", ger: "de", deu: "de",
  es: "es", spa: "es",
  it: "it", ita: "it",
  pt: "pt", por: "pt",
  nl: "nl", dut: "nl", nld: "nl",
};

/** The declared tag as a code this module can compare against a verdict.
 *  null = absent, blank, or a language this check does not measure. */
export function tagLanguageCode(tag: string | null): LanguageCode | null {
  if (tag == null) return null;
  const base = tag.trim().toLowerCase().split(/[-_]/)[0];
  return TAG_ALIASES[base] ?? null;
}

/** The declared tag as something printable: "French (fr)" when the code is
 *  known, otherwise the raw tag. */
export function describeTag(tag: string): string {
  const code = tagLanguageCode(tag);
  return code ? `${LANGUAGE_NAMES[code]} (${tag.trim()})` : tag.trim();
}

/** The languages the function-word stage can name, for UI copy. */
export const MEASURED_LANGUAGES = (Object.keys(LANGUAGE_NAMES) as LanguageCode[])
  .filter((c) => c !== "en")
  .map((c) => LANGUAGE_NAMES[c]);
