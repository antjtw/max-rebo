/**
 * Text normalisation shared by triggers and scene keywords (SPEC §9.2 step 1): lower case, strip
 * punctuation, expand contractions, number words to digits, then apply a synonym map.
 */

const CONTRACTIONS: Record<string, string> = {
  "don't": 'do not',
  "doesn't": 'does not',
  "didn't": 'did not',
  "won't": 'will not',
  "wouldn't": 'would not',
  "can't": 'can not',
  cannot: 'can not',
  "couldn't": 'could not',
  "shouldn't": 'should not',
  "isn't": 'is not',
  "aren't": 'are not',
  "wasn't": 'was not',
  "weren't": 'were not',
  "haven't": 'have not',
  "hasn't": 'has not',
  "i'm": 'i am',
  "i'll": 'i will',
  "i've": 'i have',
  "i'd": 'i would',
  "we're": 'we are',
  "we'll": 'we will',
  "you're": 'you are',
  "they're": 'they are',
  "it's": 'it is',
  "that's": 'that is',
  "there's": 'there is',
  "what's": 'what is',
  "let's": 'let us',
  "he's": 'he is',
  "she's": 'she is',
};

const NUMBERS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
};

export function expandContractions(s: string): string {
  return s.replace(/[a-z]+'[a-z]+|cannot/g, (w) => CONTRACTIONS[w] ?? w.replace(/'s$/, ''));
}

/** "twenty one" → "21", "a couple of" stays. Simple and good enough for spoken dice and Despair counts. */
export function numberWordsToDigits(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const n = NUMBERS[t];
    if (n === undefined) {
      out.push(t);
      continue;
    }
    const next = tokens[i + 1];
    const m = next !== undefined ? NUMBERS[next] : undefined;
    if (n >= 20 && n % 10 === 0 && m !== undefined && m > 0 && m < 10) {
      out.push(String(n + m));
      i++;
    } else out.push(String(n));
  }
  return out;
}

export interface SynonymMap {
  /** Multi-word variants first (longest match wins). Each variant → canonical tokens. */
  entries: { variant: string[]; canonical: string[] }[];
}

export function buildSynonyms(map: Record<string, string[]>): SynonymMap {
  const entries: SynonymMap['entries'] = [];
  for (const [canonical, variants] of Object.entries(map)) {
    const canon = basicTokens(canonical);
    for (const v of variants) {
      const vt = basicTokens(v);
      if (vt.length) entries.push({ variant: vt, canonical: canon });
    }
  }
  entries.sort((a, b) => b.variant.length - a.variant.length);
  return { entries };
}

function basicTokens(s: string): string[] {
  return expandContractions(s.toLowerCase().replace(/[’‘`]/g, "'"))
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/'/g, '')
    .split(/\s+/)
    .filter(Boolean);
}

export function applySynonyms(tokens: string[], syn: SynonymMap | null): string[] {
  if (!syn || syn.entries.length === 0) return tokens;
  const out: string[] = [];
  let i = 0;
  outer: while (i < tokens.length) {
    for (const e of syn.entries) {
      const n = e.variant.length;
      if (i + n > tokens.length) continue;
      let ok = true;
      for (let k = 0; k < n; k++) {
        if (tokens[i + k] !== e.variant[k]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        out.push(...e.canonical);
        i += n;
        continue outer;
      }
    }
    out.push(tokens[i]!);
    i++;
  }
  return out;
}

/** Full pipeline → tokens. */
export function normalise(text: string, syn: SynonymMap | null = null): string[] {
  return applySynonyms(numberWordsToDigits(basicTokens(text)), syn);
}

/** Find a phrase (already normalised tokens) as a contiguous token run. Returns start index or -1. */
export function findPhrase(tokens: string[], phrase: string[]): number {
  if (phrase.length === 0) return -1;
  outer: for (let i = 0; i + phrase.length <= tokens.length; i++) {
    for (let k = 0; k < phrase.length; k++) if (tokens[i + k] !== phrase[k]) continue outer;
    return i;
  }
  return -1;
}
