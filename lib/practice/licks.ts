// The Lick library. Content transcribed verbatim from the research brief at
// ~/Downloads/compass_artifact_wf-037aa23d-5b73-4ee3-8946-8905eddc8078_text_markdown.md.
// All tabs and attributions preserved exactly — do not invent or paraphrase.
// Adding/removing a lick: edit this file, rebuild, deploy. No DB seeding.

export type LickDifficulty = 1 | 2 | 3;

export type LickTag =
  | "alternate-picking"
  | "pull-offs"
  | "hammer-ons"
  | "legato"
  | "bending"
  | "vibrato"
  | "slides"
  | "double-stops"
  | "target-chord-tone"
  | "repetition-motif"
  | "rhythmic-displacement"
  | "call-response"
  | "b5-blues-note";

export type Lick = {
  id: string;
  name: string;
  // Attribution string. Honest labeling — "Verified…", "In the style of…",
  // "Pastiche — …", "Grammar — …". Preserved verbatim from the research.
  origin: string;
  difficulty: LickDifficulty;
  teaches: LickTag[];
  // AlphaTex source for rendering via AlphaTab. Strings are 1=high-e … 6=low-E.
  // A leading `\tempo 80 . :8` etc. is fine; see lib/practice/licks.ts for the
  // effect vocabulary in use ({h} hammer, {p} pull, {b (0 4)} whole-step bend,
  // {v} vibrato, {sl} slide into).
  alphaTex: string;
  // Tempo for AlphaTab's built-in player. 80 bpm is a safe default.
  tempo?: number;
  // Extra explanatory text shown below the tab (e.g. "Played as 4-note cells").
  tabNote?: string;
  coaching: string;
  youtubeSearch: string;
  // Set on licks that intentionally leave box 1 for technique reasons.
  boxExcursion?: string;
};

export const LICKS: Lick[] = [
  {
    id: "am-pent-ascending-box1-run",
    name: "Ascending box 1 run",
    origin: "Grammar / traditional scale exercise",
    difficulty: 1,
    teaches: ["alternate-picking"],
    tempo: 80,
    alphaTex: `:8 5.6 8.6 5.5 7.5 5.4 7.4 5.3 7.3 5.2 8.2 5.1 8.1`,
    coaching:
      "Strict down-up alternation. The 2-notes-per-string shape means each string change flips picking orientation — this is where beginners accidentally \"reset\" to a downstroke. Start at 60 bpm quarter notes before moving to 80 bpm eighths.",
    youtubeSearch:
      "A minor pentatonic box 1 ascending alternate picking exercise",
  },
  {
    id: "am-pent-descending-pulloffs",
    name: "Descending box 1 with pull-offs",
    origin: "Grammar / traditional scale exercise",
    difficulty: 1,
    teaches: ["pull-offs", "legato"],
    tempo: 80,
    alphaTex: `:8 8.1{p} 5.1 8.2{p} 5.2 7.3{p} 5.3 7.4{p} 5.4 7.5{p} 5.5 8.6{p} 5.6`,
    coaching:
      "Pick only the first note of each pair. The pull-off must pluck the string sideways — otherwise the second note is weak. Aim for equal volume on both notes.",
    youtubeSearch: "descending pentatonic pull off exercise box 1",
  },
  {
    id: "am-pent-zigzag-connection",
    name: "Box 1 \"fours\" zigzag",
    origin: "Grammar / traditional 4-note cell sequence",
    difficulty: 2,
    teaches: [
      "alternate-picking",
      "hammer-ons",
      "pull-offs",
      "repetition-motif",
    ],
    tempo: 80,
    alphaTex: `:16 8.1 5.1 8.2 5.2 8.2 5.2 7.3 5.3 7.3 5.3 7.4 5.4 7.4 5.4 7.5 5.5`,
    tabNote:
      "Played as 4-note groupings: (e8 e5 B8 B5) (B8 B5 G7 G5) (G7 G5 D7 D5) (D7 D5 A7 A5)",
    coaching:
      "Each cell overlaps the next by one string. That overlap is where most players lose sync. Play each cell alone first, then connect.",
    youtubeSearch:
      "pentatonic box 1 fours sequence alternate picking exercise",
  },
  {
    id: "am-pent-bb-style-box1-opener",
    name: "BB-King-style box 1 opener",
    origin:
      "In the style of B.B. King — his actual \"BB Box\" sits at frets 10–12 (per Guitar World/Aledort, Happy Bluesman, JustinGuitar); this is a stylistic box-1 pastiche using BB's phrasing grammar.",
    difficulty: 2,
    teaches: ["bending", "vibrato", "target-chord-tone", "repetition-motif"],
    tempo: 80,
    alphaTex: `:4 8.2{b (0 4)} :8 8.2 5.2 7.3 8.1 :4 5.1{v}`,
    tabNote: "b(10) = whole-step bend (♭7 → root).",
    coaching:
      "The bend must arrive fully at pitch before you add vibrato — BB's \"butterfly\" vibrato is on the bent note, not during the bend. This is a stylistic box-1 adaptation; BB's real A-key licks live at fret 10–12.",
    youtubeSearch:
      "BB King style box 1 A minor pentatonic lick Thrill Is Gone phrasing",
  },
  {
    id: "am-pent-chuck-berry-double-stop",
    name: "Chuck Berry double-stop",
    origin:
      "Johnny B. Goode intro (1958, Chess, originally in B♭), transposed down a half-step to A — shape verified against Songsterr, Ultimate-Guitar, Cifra Club, MrTabs; functionally major/dominant.",
    difficulty: 2,
    teaches: ["double-stops", "slides", "bending", "repetition-motif"],
    tempo: 80,
    alphaTex: `:8 5.3{sl} 6.3 (6.3 5.2) (6.3 7.2) 5.3{sl} 6.3 (6.3 5.2) (6.3 7.2) | :8 5.3{sl} 6.3 (6.3 5.2) (6.3 7.2) r r r r`,
    coaching:
      "Pick G+B strings together. G-string is the moving voice (♭3 → 3, Chuck's \"curl\"), B-string is the pedal. Staccato and percussive — Berry played these straight-eighths while the band swung. Functionally major/dominant, so in a strict A minor jam use sparingly over the I chord.",
    youtubeSearch:
      "Johnny B Goode intro lesson Chuck Berry double stop guitar tab",
  },
  {
    id: "am-pent-traditional-turnaround",
    name: "I→V turnaround (♭7 → root)",
    origin:
      "Traditional blues vocabulary — not attributable (Guitar World's Sue Foley \"Essential Blues Turnarounds\" confirms).",
    difficulty: 1,
    teaches: ["target-chord-tone", "call-response"],
    tempo: 80,
    alphaTex: `:8 5.4 7.4 5.3 7.3 5.3 5.2 8.2 :4 5.1`,
    coaching:
      "Land the final A (high-E fret 5) exactly on beat 1 of the next chorus. The turnaround \"points\" to the downbeat — if you land early or late, the form collapses.",
    youtubeSearch: "blues turnaround A minor pentatonic box 1 lick traditional",
  },
  {
    id: "am-pent-slow-blues-phrasing",
    name: "Slow blues 6/8 phrase",
    origin:
      "Pastiche — in the style of Clapton slow blues; his \"Have You Ever Loved A Woman\" (E.C. Was Here / 24 Nights) is in C, not A, so no direct transcription fits. Stylistic composite of Clapton / Peter Green / Gary Moore vocabulary.",
    difficulty: 2,
    teaches: ["bending", "vibrato", "target-chord-tone", "call-response"],
    tempo: 60,
    alphaTex: `\\ts 6 8 . :2 8.2{b (0 4)}{v} :8 8.2 5.2 7.3 :4 5.3{v}`,
    coaching:
      "The bend must be SLOW — lean into pitch over ~2 beats, then vibrato for another 2+ beats. Stylistic pastiche of Clapton / Peter Green / Gary Moore slow-blues vocabulary; no specific transcription because the canonical Clapton examples (HYELAW, etc.) are in C, not A.",
    youtubeSearch: "slow blues lick A minor Clapton Peter Green Gary Moore style",
  },
  {
    id: "am-pent-page-heartbreaker",
    name: "Heartbreaker unaccompanied solo opener",
    origin:
      "Verified, native A minor pentatonic — Jimmy Page, Led Zeppelin II (1969), unaccompanied solo at ~2:01. Box-1 variant shown (omits behind-the-nut bends). Source: Guitar World \"Soloing Strategies: Jimmy Page\" Fig. 5A, Songsterr, Hal Leonard transcription book references.",
    difficulty: 2,
    teaches: [
      "pull-offs",
      "vibrato",
      "repetition-motif",
      "rhythmic-displacement",
    ],
    tempo: 80,
    alphaTex: `:4 7.3{v} :8 5.3 7.4 5.4 (5.4 7.5) 5.4 | :4 7.3{v} :8 5.3 7.4 5.4 (5.4 7.5) 5.4`,
    coaching:
      "The rhythm is deliberately loose — Page's phrasing was praised by Van Halen, Vai, and Rick Rubin for its \"awkwardness.\" Don't over-quantize. The pull-offs need aggressive attack on the 7th-fret G hammer, and the pull-off to 5 must pluck sideways. The original's behind-the-nut bends are omitted here to keep the lick cleanly inside frets 5–8; if you add them you exit the box.",
    youtubeSearch: "Jimmy Page Heartbreaker unaccompanied solo lesson",
  },
  {
    id: "am-pent-clapton-crossroads-box1",
    name: "Crossroads Solo 1 opener (box-1 voicing)",
    origin:
      "Eric Clapton, Cream, Wheels of Fire, Winterland 10 Mar 1968, Solo 1 at ~1:10. Original is in 17th-position A minor pentatonic; the octave-down voicing used here is explicitly published in Premier Guitar (\"Eric Clapton's 'Crossroads' Solo Revisited,\" Shawn Persinger, 19 May 2024).",
    difficulty: 2,
    teaches: [
      "hammer-ons",
      "pull-offs",
      "bending",
      "target-chord-tone",
      "rhythmic-displacement",
      "call-response",
    ],
    tempo: 80,
    alphaTex: `:8 7.4 5.3 5.2 8.2 7.3 5.3 5.2 :4 7.3{v} :8 7.4`,
    coaching:
      "Rhythm is the whole point, not notes. Clapton said of Solo 1: \"I'm on the 2 and I should be on the 1.\" Phrases start on beat 3 constantly. The C → C♯ grace-note move (optional hammer from B-string fret 8 up one fret, briefly touching fret 9 — minor box excursion) is his signature blue-third-to-major-third color. This is an octave-down voicing of Clapton's actual 17th-fret solo, published in Premier Guitar May 2024 — a \"Crossroads-style box-1 voicing,\" not the Clapton solo verbatim.",
    youtubeSearch: "Clapton Crossroads solo first chorus lesson box 1",
  },
  {
    id: "am-pent-hendrix-voodoo-child-transposed",
    name: "Voodoo Child intro lick (transposed)",
    origin:
      "Jimi Hendrix, Electric Ladyland (1968), intro figure ~0:16–0:32. Original is E minor pentatonic box 1 at fret 12 (E♭ standard tuning); transposed down a 5th to A minor box 1 at fret 5. Shape identical, technique identical. Sources: E-chords, MrTabs, Musicnotes (Hal Leonard), Songsterr.",
    difficulty: 2,
    teaches: [
      "pull-offs",
      "hammer-ons",
      "legato",
      "repetition-motif",
      "call-response",
    ],
    tempo: 90,
    alphaTex: `:16 5.3 5.3{h} 7.3{p} 5.3 7.3{p} 5.3 7.4 5.4 5.4 5.4{h} 7.4{p} 5.4 7.5 5.3{h} 7.3{p} 5.3 7.3{p} 5.3`,
    coaching:
      "The pull-off sequence 7p5h7p5 on G string must be left-hand only at constant volume — the right hand does not re-attack. The D-string 5h7p5 is a registral dip giving the phrase its snake-like quality. Rhythm is loose and swung; straight 16ths sound mechanical. Original is E minor pentatonic at fret 12; this is transposed down a 5th to A minor box 1. The shape and technique are 100% Hendrix; only the key is changed.",
    youtubeSearch: "Voodoo Child Slight Return intro riff lesson tab",
  },
  {
    id: "am-pent-young-cortez-style",
    name: "Cortez-flavored bend phrase (transposed)",
    origin:
      "In the style of Neil Young, \"Cortez the Killer,\" Zuma (1975) — song is in E minor, transposed to A minor box 1. Young's solos are heavily improvised take-to-take; the vocabulary (long bend, wide vibrato, target root) is authentic, the exact rhythm is generalized. Sources: HyperRust, Songsterr, Ultimate Guitar.",
    difficulty: 1,
    teaches: [
      "bending",
      "vibrato",
      "target-chord-tone",
      "repetition-motif",
      "call-response",
    ],
    tempo: 70,
    alphaTex: `:4 8.2{b (0 4)} :8 7.3 8.2 8.2{b (0 4 0)} 7.3 5.2 7.3 5.2 7.3 5.3 7.4`,
    tabNote: "b(10)r8 = bend up a whole step, release to pitch of fret 8.",
    coaching:
      "Hold notes longer than feels comfortable. The bend to root on B-string (8 → 10) is Young's single most recognizable move across \"Cortez,\" \"Like a Hurricane,\" \"Down by the River.\" Bend slow, let it cry, release slow. The 10th-fret target pitch is only reached as a bend, not a fretted note — the fingering stays in frets 5–8.",
    youtubeSearch: "Neil Young Cortez the Killer solo lesson Em pentatonic",
  },
  {
    id: "am-pent-call-response",
    name: "Two-bar call & response",
    origin: "Pastiche — traditional blues call-and-response grammar.",
    difficulty: 2,
    teaches: ["call-response", "target-chord-tone", "bending", "vibrato"],
    tempo: 80,
    alphaTex: `:8 5.2 :4 8.2{b (0 4)} :8 7.3 5.3 7.4 r | :8 5.2 8.2 5.2 7.3 5.3 :4 7.4{v} 5.6{v}`,
    tabNote: "Bar 1 = call (ends on tension). Bar 2 = response (resolves to A).",
    coaching:
      "Bar 1 must feel like a question — don't let the final note resolve. Bar 2 is the answer — land squarely on an A root with vibrato. Leave a tiny silence between the two phrases. The space IS the conversation.",
    youtubeSearch: "blues call and response phrasing minor pentatonic lesson",
  },
  {
    id: "am-pent-rhythmic-displacement",
    name: "Question/answer with anticipation",
    origin: "Pastiche — traditional rhythmic-displacement grammar.",
    difficulty: 3,
    teaches: [
      "rhythmic-displacement",
      "call-response",
      "target-chord-tone",
      "vibrato",
    ],
    tempo: 80,
    alphaTex: `:8 5.2 8.2 5.2 8.2 7.3 5.1 8.2 r | :8 5.3 7.3 7.4 5.3 7.4 7.5 :4 5.6{v}`,
    tabNote: "Bar 1 = question (pushes into bar 2). Bar 2 = displaced answer.",
    coaching:
      "The trick is anticipation — the answer starts before beat 1 of bar 2. Tap downbeats with your foot while the phrase pushes against them. If resolution lands on the downbeat, you've lost the displacement — delay it to the \"and of 3\" for lazy-blues feel.",
    youtubeSearch: "blues phrasing rhythmic anticipation syncopation pentatonic",
  },
  {
    id: "am-pent-legato-3nps",
    name: "3-notes-per-string legato run",
    origin: "Grammar — modern rock/fusion application of box 1.",
    difficulty: 3,
    teaches: ["legato", "hammer-ons", "alternate-picking"],
    boxExcursion:
      "Fret 4 (G-string F♯) and fret 8 (A-string F, D-string B♭) are chromatic additions outside strict A minor pentatonic. For a pure in-box variant, omit the 8s and the 4.",
    tempo: 80,
    alphaTex: `:8 5.6 7.6 8.6 5.5 7.5 8.5 5.4 7.4 8.4 4.3 5.3 7.3 5.2 7.2 8.2 5.1 7.1 8.1`,
    coaching:
      "This is NOT a blues lick — it's a legato/technique exercise using box 1 as launchpad. Use to build hand strength; don't play it in a pure blues solo.",
    youtubeSearch:
      "three notes per string pentatonic legato A minor exercise",
  },
  {
    id: "am-pent-b5-chromatic",
    name: "♭5 blues-note chromatic slide",
    origin: "Traditional blues-scale grammar (minor pentatonic + ♭5).",
    difficulty: 2,
    teaches: ["b5-blues-note", "slides", "target-chord-tone", "hammer-ons"],
    tempo: 80,
    alphaTex: `:8 (5.6 5.5) 7.5 6.5 7.5 5.4 7.4 5.3 7.3 5.2 :4 5.1`,
    tabNote: "A-string walk: A (5) → E (7) → E♭ (6) → E (7). Slide through the ♭5, never stop on it.",
    coaching:
      "The ♭5 (E♭, A-string fret 6) is a passing tone, not a landing tone — always move through it, never stop on it. The classic move is E → E♭ → D on 5th string (7 → 6 → 5) or E → E♭ → E (7 → 6 → 7). Sit on E♭ and it sounds wrong; slide through it and it sounds like the blues.",
    youtubeSearch: "A blues scale b5 flat five chromatic lick box 1 lesson",
  },
];

export function getLickById(id: string): Lick | undefined {
  return LICKS.find((l) => l.id === id);
}
