import { doubleMetaphone } from 'double-metaphone';
import { normalise, type SynonymMap } from '../text/normalise.ts';

/**
 * Phrase patterns (SPEC §9.2): `(a|b c)` alternatives, `[word]` / `[a|b]` optional, and slots
 * `{character}`, `{player}`, `{number}`. Matching is token-level with Levenshtein and Double
 * Metaphone tolerance, so recognition slips like "ignite mile lightsaber" still match.
 */

export type SlotName = 'character' | 'player' | 'number';

export type Element =
  { kind: 'alt'; options: string[][]; optional: boolean } | { kind: 'slot'; name: SlotName };

export interface Pattern {
  source: string;
  elements: Element[];
}

export interface NameEntry {
  tokens: string[];
  id: string;
}

export interface SlotVocab {
  character: NameEntry[];
  player: NameEntry[];
  /**
   * Words that appear verbatim in any pattern. A heard word that is itself a known word only
   * matches exactly, so "deactivate" never fuzzy-matches "activate".
   */
  known?: Set<string>;
}

export interface MatchResult {
  score: number;
  start: number;
  end: number; // exclusive
  /** Index of the first matched non-pronoun word (the "verb"), for the negation guard. */
  verbIndex: number;
  slots: Partial<Record<SlotName, string>>;
  pattern: string;
}

const PRONOUNS = new Set(['i', 'my', 'me', 'we', 'our', 'the', 'a', 'his', 'her', 'their', 'up']);

/** Split a pattern into raw parts, respecting brackets. */
function lex(src: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ') {
      i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      const close = c === '(' ? ')' : c === '[' ? ']' : '}';
      const j = src.indexOf(close, i);
      if (j < 0) throw new Error(`Unclosed "${c}" in pattern "${src}"`);
      // `(the )?` regex-style optional from older configs → treat as optional.
      let part = src.slice(i, j + 1);
      if (src[j + 1] === '?') {
        part = `[${part.slice(1, -1)}]`;
        i = j + 2;
      } else i = j + 1;
      parts.push(part);
      continue;
    }
    let j = i;
    while (j < src.length && !' ([{'.includes(src[j]!)) j++;
    parts.push(src.slice(i, j));
    i = j;
  }
  return parts;
}

export function compilePattern(src: string, syn: SynonymMap | null = null): Pattern {
  const elements: Element[] = [];
  for (const part of lex(src.trim())) {
    if (part.startsWith('{')) {
      const name = part.slice(1, -1).trim();
      if (name !== 'character' && name !== 'player' && name !== 'number') {
        throw new Error(`Unknown slot {${name}} in "${src}"`);
      }
      elements.push({ kind: 'slot', name });
      continue;
    }
    const optional = part.startsWith('[');
    const inner = part.startsWith('(') || optional ? part.slice(1, -1) : part;
    const options = inner
      .split('|')
      .map((o) => normalise(o, syn))
      .filter((o) => o.length > 0);
    if (options.length === 0) continue;
    // A plain multi-word chunk normalised into several tokens becomes consecutive single words.
    if (!part.startsWith('(') && !optional && options.length === 1 && options[0]!.length > 1) {
      for (const t of options[0]!) elements.push({ kind: 'alt', options: [[t]], optional: false });
      continue;
    }
    elements.push({ kind: 'alt', options, optional });
  }
  return { source: src, elements };
}

/* ----------------------------- similarity ----------------------------- */

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

const metaCache = new Map<string, [string, string]>();
function meta(w: string): [string, string] {
  let m = metaCache.get(w);
  if (!m) {
    m = doubleMetaphone(w);
    if (metaCache.size > 5000) metaCache.clear();
    metaCache.set(w, m);
  }
  return m;
}

/** Similarity of a heard token to an expected word, 0 if not acceptable. */
export function wordSimilarity(
  heard: string,
  expected: string,
  fuzziness: number,
  known?: Set<string>,
): number {
  if (heard === expected) return 1;
  if (known?.has(heard)) return 0;
  if (/^\d+$/.test(expected) || /^\d+$/.test(heard)) return 0;
  const maxLen = Math.max(heard.length, expected.length);
  const ratio = 1 - levenshtein(heard, expected) / maxLen;
  // Short words must match exactly or nearly: "my" vs "mile" should not pass on edit distance.
  if (expected.length >= 4 && ratio >= 1 - fuzziness) return ratio;
  if (expected.length >= 3) {
    const [a1, a2] = meta(heard);
    const [b1, b2] = meta(expected);
    if (a1 && (a1 === b1 || a1 === b2 || (a2 && (a2 === b1 || a2 === b2)))) return 0.85;
  }
  return 0;
}

/* ------------------------------- matching ------------------------------ */

interface State {
  i: number; // token index
  score: number;
  words: number;
  verbIndex: number;
  slots: Partial<Record<SlotName, string>>;
  fillers: number;
}

const MAX_FILLERS = 1;
const FILLER_PENALTY = 0.12;

/**
 * Best match of a pattern anywhere in the token list (start positions are tried left to right;
 * the highest-scoring match wins).
 */
export function matchPattern(
  pattern: Pattern,
  tokens: string[],
  vocab: SlotVocab,
  fuzziness: number,
): MatchResult | null {
  let best: MatchResult | null = null;
  for (let start = 0; start < tokens.length; start++) {
    const r = matchFrom(
      pattern.elements,
      0,
      { i: start, score: 0, words: 0, verbIndex: -1, slots: {}, fillers: 0 },
      tokens,
      vocab,
      fuzziness,
    );
    if (r && r.words > 0) {
      const score = r.score / r.words - r.fillers * FILLER_PENALTY;
      if (!best || score > best.score) {
        best = {
          score,
          start,
          end: r.i,
          verbIndex: r.verbIndex >= 0 ? r.verbIndex : start,
          slots: r.slots,
          pattern: pattern.source,
        };
        if (score >= 0.999) break;
      }
    }
  }
  return best;
}

function matchFrom(
  els: Element[],
  k: number,
  st: State,
  tokens: string[],
  vocab: SlotVocab,
  fuzz: number,
): State | null {
  if (k === els.length) return st;
  const el = els[k]!;
  let best: State | null = null;
  const consider = (s: State | null) => {
    if (
      s &&
      (!best ||
        s.score / Math.max(1, s.words) - s.fillers * FILLER_PENALTY >
          best.score / Math.max(1, best.words) - best.fillers * FILLER_PENALTY)
    ) {
      best = s;
    }
  };

  if (el.kind === 'slot') {
    for (const m of matchSlot(el.name, tokens, st.i, vocab, fuzz)) {
      consider(
        matchFrom(
          els,
          k + 1,
          {
            ...st,
            i: st.i + m.len,
            score: st.score + m.score,
            words: st.words + 1,
            slots: { ...st.slots, [el.name]: m.id },
          },
          tokens,
          vocab,
          fuzz,
        ),
      );
    }
  } else {
    for (const opt of el.options) {
      const m = matchWords(opt, tokens, st.i, fuzz, vocab.known);
      if (m) {
        const isVerb = st.verbIndex < 0 && !opt.every((w) => PRONOUNS.has(w));
        consider(
          matchFrom(
            els,
            k + 1,
            {
              ...st,
              i: st.i + m.len,
              score: st.score + m.score * opt.length,
              words: st.words + opt.length,
              verbIndex: isVerb ? st.i : st.verbIndex,
            },
            tokens,
            vocab,
            fuzz,
          ),
        );
      }
    }
    if (el.optional) consider(matchFrom(els, k + 1, st, tokens, vocab, fuzz));
  }
  // Allow one filler word between elements (not before the first): "ignite my blue lightsaber".
  if (!best && k > 0 && st.fillers < MAX_FILLERS && st.i < tokens.length) {
    consider(
      matchFrom(els, k, { ...st, i: st.i + 1, fillers: st.fillers + 1 }, tokens, vocab, fuzz),
    );
  }
  return best;
}

/** Match consecutive expected words, also allowing two heard tokens to merge into one expected word. */
function matchWords(
  expected: string[],
  tokens: string[],
  at: number,
  fuzz: number,
  known?: Set<string>,
): { len: number; score: number } | null {
  let i = at;
  let total = 0;
  for (const w of expected) {
    const t = tokens[i];
    if (t === undefined) return null;
    let s = wordSimilarity(t, w, fuzz, known);
    let used = 1;
    const t2 = tokens[i + 1];
    if (t2 !== undefined && w.length >= 6) {
      const merged = wordSimilarity(t + t2, w, fuzz, known);
      if (merged > s) {
        s = merged;
        used = 2;
      }
    }
    if (s <= 0) return null;
    total += s;
    i += used;
  }
  return { len: i - at, score: total / expected.length };
}

function matchSlot(
  name: SlotName,
  tokens: string[],
  at: number,
  vocab: SlotVocab,
  fuzz: number,
): { len: number; score: number; id: string }[] {
  if (name === 'number') {
    const t = tokens[at];
    return t !== undefined && /^\d+$/.test(t) ? [{ len: 1, score: 1, id: t }] : [];
  }
  const entries = name === 'character' ? vocab.character : vocab.player;
  const out: { len: number; score: number; id: string }[] = [];
  for (const e of entries) {
    const m = matchWords(e.tokens, tokens, at, fuzz);
    if (m && m.score >= 0.8) out.push({ len: m.len, score: m.score, id: e.id });
  }
  return out.sort((a, b) => b.score - a.score || b.len - a.len).slice(0, 2);
}
