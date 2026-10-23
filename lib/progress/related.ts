/**
 * How lectures relate: by the distinctive words they share. Each lecture's summary
 * and concepts become a TF-IDF vector — a word counts for more the rarer it is across
 * your lectures, so "cell" in every lecture barely links them while "mesangium" in two
 * links those two strongly — and two lectures' closeness is the cosine of their vectors.
 */

const STOP = new Set(
  (
    "the and for are but not you all any can had her was one our out has have him his how its may new now old see two way who did get let put say she too use that with this from they will would there their what about which when your into than then them these some could other more also been were each like make many most much must only over such very well where while just being both does done down even here know made same should since through under upon used using what when whom why within without again against among because before between during further having however itself less made might once rather themselves therefore those though thus until whether yet "
    + "lecture lectures slide slides summary summaries key point points figure figures example examples important note notes include includes including include main overview introduction section topic topics also eg ie etc via per page part parts way ways type types term terms called known show shows shown result results due role roles level levels form forms process processes effect effects cause causes increase increased decrease decreased high low large small different normal common follow follows following followed lead leads occur occurs seen give gives given take takes found involve involves usually often"
  ).split(/\s+/),
);

/** The words of a text worth comparing: lower case, no Markdown, no stop words, plurals folded. */
export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\]\([^)]*\)/g, " ")
    .split(/[^a-z0-9α-ω]+/)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w))
    .map(singular);
}

/** Plurals folded to real words: deposits → deposit, complexes → complex, arteries → artery. */
function singular(w: string): string {
  if (w.length <= 4 || !w.endsWith("s")) return w;
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (/(ss|is|us|as)$/.test(w)) return w;
  if (/(sses|xes|ches|shes|zes)$/.test(w)) return w.slice(0, -2);
  return w.slice(0, -1);
}

export interface Relation {
  a: string;
  b: string;
  /** 0–1: how alike the two lectures are. */
  score: number;
  /** The words that do most of the linking, strongest first. */
  shared: string[];
}

/**
 * Each lecture's closest few, above a floor, as undirected links (a pair once).
 * `perLecture` keeps the map readable; `floor` keeps chance overlaps out.
 */
export function relate(docs: Array<{ id: string; text: string }>, opts: { perLecture?: number; floor?: number } = {}): Relation[] {
  const perLecture = opts.perLecture ?? 3;
  const floor = opts.floor ?? 0.08;
  const n = docs.length;
  if (n < 2) return [];
  const counts = docs.map((d) => {
    const m = new Map<string, number>();
    for (const t of terms(d.text)) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  });
  const df = new Map<string, number>();
  for (const m of counts) for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const vectors = counts.map((m) => {
    const v = new Map<string, number>();
    let norm = 0;
    for (const [t, c] of m) {
      const w = (1 + Math.log(c)) * Math.log(1 + n / df.get(t)!);
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  });

  const pair = (i: number, j: number): Relation => {
    const [small, big] = vectors[i].size < vectors[j].size ? [vectors[i], vectors[j]] : [vectors[j], vectors[i]];
    let score = 0;
    const parts: Array<[string, number]> = [];
    for (const [t, w] of small) {
      const other = big.get(t);
      if (other === undefined) continue;
      score += w * other;
      parts.push([t, w * other]);
    }
    parts.sort((x, y) => y[1] - x[1]);
    return { a: docs[i].id, b: docs[j].id, score, shared: parts.slice(0, 5).map(([t]) => t) };
  };

  const all: Relation[][] = docs.map(() => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const r = pair(i, j);
      if (r.score < floor) continue;
      all[i].push(r);
      all[j].push(r);
    }
  }
  const kept = new Map<string, Relation>();
  for (const list of all) {
    for (const r of list.sort((x, y) => y.score - x.score).slice(0, perLecture)) kept.set(`${r.a}|${r.b}`, r);
  }
  return [...kept.values()].sort((x, y) => y.score - x.score);
}

/** The document most like a short text (a past-paper question, say), by the same measure; null when nothing is shared. */
export function closest(query: string, docs: Array<{ id: string; text: string }>): { id: string; score: number } | null {
  if (!docs.length) return null;
  const links = relate([...docs, { id: "\u0000query", text: query }], { perLecture: docs.length + 1, floor: 0.01 });
  const best = links.find((l) => l.a === "\u0000query" || l.b === "\u0000query");
  return best ? { id: best.a === "\u0000query" ? best.b : best.a, score: best.score } : null;
}
