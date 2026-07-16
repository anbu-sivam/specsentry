import { describe, expect, it } from 'vitest';
import { classify, sortBySeverity, summarize } from '../src/classifier.js';
import { RULES } from '../src/rules.js';
import type { RawDifference } from '../src/types.js';

describe('classify', () => {
  it('assigns severity and message from the rules table', () => {
    const raw: RawDifference[] = [{ kind: 'path.removed', location: 'paths./pets' }];

    const [result] = classify(raw);

    expect(result?.severity).toBe('BREAKING');
    expect(result?.message).toBe(RULES['path.removed'].message);
  });

  it('preserves the raw difference fields', () => {
    const raw: RawDifference[] = [
      { kind: 'schema.type.changed', location: 'Pet.id', before: 'string', after: 'integer' },
    ];

    const [result] = classify(raw);

    expect(result?.location).toBe('Pet.id');
    expect(result?.before).toBe('string');
    expect(result?.after).toBe('integer');
  });

  it('returns an empty list for no differences', () => {
    expect(classify([])).toEqual([]);
  });
});

describe('sortBySeverity', () => {
  it('orders breaking first and non-breaking last', () => {
    const classified = classify([
      { kind: 'path.added', location: 'b' },
      { kind: 'path.removed', location: 'a' },
      { kind: 'operation.deprecated', location: 'c' },
    ]);

    expect(sortBySeverity(classified).map((d) => d.severity)).toEqual([
      'BREAKING',
      'WARNING',
      'NON_BREAKING',
    ]);
  });
});

describe('summarize', () => {
  it('counts each severity', () => {
    const classified = classify([
      { kind: 'path.removed', location: 'a' },
      { kind: 'method.removed', location: 'b' },
      { kind: 'path.added', location: 'c' },
      { kind: 'operation.deprecated', location: 'd' },
    ]);

    expect(summarize(classified)).toEqual({ BREAKING: 2, WARNING: 1, NON_BREAKING: 1 });
  });

  it('reports zeroes for an empty diff', () => {
    expect(summarize([])).toEqual({ BREAKING: 0, WARNING: 0, NON_BREAKING: 0 });
  });
});

describe('rules table', () => {
  it('gives every rule a message and a rationale', () => {
    for (const [kind, rule] of Object.entries(RULES)) {
      expect(rule.message, `${kind} message`).not.toBe('');
      expect(rule.rationale, `${kind} rationale`).not.toBe('');
    }
  });
});
