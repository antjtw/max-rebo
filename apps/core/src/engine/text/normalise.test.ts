import { describe, expect, it } from 'vitest';
import { buildSynonyms, findPhrase, normalise } from './normalise.ts';

describe('normalise', () => {
  it('lower-cases, strips punctuation and expands contractions', () => {
    expect(normalise("Right, I DON'T ignite my lightsaber!")).toEqual([
      'right',
      'i',
      'do',
      'not',
      'ignite',
      'my',
      'lightsaber',
    ]);
    expect(normalise("Something's wrong")).toEqual(['something', 'wrong']);
    expect(normalise('I can’t')).toEqual(['i', 'can', 'not']);
  });

  it('turns number words into digits', () => {
    expect(normalise('I spend three Despair')).toEqual(['i', 'spend', '3', 'despair']);
    expect(normalise('twenty one')).toEqual(['21']);
  });

  it('applies multi-word synonyms, longest first', () => {
    const syn = buildSynonyms({ lightsaber: ['light saber', 'sabre', 'saber', 'lights abre'] });
    expect(normalise('I ignite my light saber', syn)).toEqual(['i', 'ignite', 'my', 'lightsaber']);
    expect(normalise('ignite mile lights abre', syn)).toEqual(['ignite', 'mile', 'lightsaber']);
    expect(normalise('my sabre', syn)).toEqual(['my', 'lightsaber']);
  });

  it('finds contiguous phrases', () => {
    expect(findPhrase(['we', 'take', 'a', 'full', 'rest'], ['full', 'rest'])).toBe(3);
    expect(findPhrase(['full', 'of', 'rest'], ['full', 'rest'])).toBe(-1);
  });
});
