import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectDrift } from '../src/index.js';
import { RULES } from '../src/rules.js';
import { SUGGESTIONS, suggestionFor } from '../src/suggestions.js';
import type { DiffKind } from '../src/types.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const kinds = Object.keys(RULES) as DiffKind[];

describe('suggestionFor names the thing that changed', () => {
  it('tells you to restore a removed method, by name', () => {
    const suggestion = suggestionFor('method.removed', { path: '/pets/{petId}', method: 'delete' });

    expect(suggestion).toBe(
      'Restore DELETE /pets/{petId} and mark it deprecated, or move the removal to a new API version.',
    );
  });

  it('omits the method for a removed path, which took every method with it', () => {
    const suggestion = suggestionFor('path.removed', { path: '/pets' });

    expect(suggestion).toBe(
      'Restore /pets and mark it deprecated, or move the removal to a new API version.',
    );
  });

  it('tells you to default a newly required request field, by name', () => {
    const suggestion = suggestionFor('request.property.added.required', {
      path: '/pets',
      method: 'post',
      direction: 'request',
      field: ['species'],
    });

    expect(suggestion).toBe(
      'Add `species` as optional with a server-side default, and require it once senders have migrated.',
    );
  });

  it('tells you to keep returning a removed response field, by name', () => {
    const suggestion = suggestionFor('response.property.removed', {
      path: '/pets/{petId}',
      method: 'get',
      direction: 'response',
      field: ['tag'],
    });

    expect(suggestion).toBe(
      'Keep returning `tag` for a deprecation cycle, then drop it in a new API version.',
    );
  });

  it('addresses a nested field the way a client writes it', () => {
    const suggestion = suggestionFor('response.property.removed', {
      path: '/pets',
      method: 'get',
      direction: 'response',
      field: ['owner', 'name'],
    });

    expect(suggestion).toContain('`owner.name`');
  });

  it('gives opposite advice for the same edit on each side of the wire', () => {
    const request = suggestionFor('request.property.type.changed', { field: ['id'] });
    const response = suggestionFor('response.property.type.changed', { field: ['id'] });

    // A sender needs the server to accept both; a reader needs the old field
    // left alone. Same structural edit, different fix.
    expect(request).toContain('Accept both the old and the new type');
    expect(response).toContain('Return the new type in a new field');
    expect(request).not.toBe(response);
  });

  it('falls back when there is no field to name', () => {
    // A parameter's inner schema has no body field.
    const suggestion = suggestionFor('response.property.removed', { path: '/pets', method: 'get' });

    expect(suggestion).toBe(
      'Keep returning the property for a deprecation cycle, then drop it in a new API version.',
    );
    expect(suggestion).not.toContain('``');
  });

  it('falls back when there is no target at all', () => {
    expect(suggestionFor('method.removed')).toContain('this endpoint');
  });
});

describe('suggestionFor stays silent', () => {
  it('for an additive change', () => {
    expect(suggestionFor('path.added', { path: '/health' })).toBeUndefined();
    expect(suggestionFor('response.property.added', { field: ['nickname'] })).toBeUndefined();
  });

  it('for a change that loosens a constraint', () => {
    expect(suggestionFor('param.required.loosened', { path: '/pets', method: 'get' })).toBeUndefined();
  });

  it('for the version bump', () => {
    expect(suggestionFor('info.version.changed')).toBeUndefined();
  });
});

describe('the suggestions table', () => {
  it('covers every kind the rules table knows', () => {
    expect(Object.keys(SUGGESTIONS).sort()).toEqual(kinds.sort());
  });

  it('advises on every BREAKING kind', () => {
    const unadvised = kinds.filter(
      (kind) => RULES[kind].severity === 'BREAKING' && SUGGESTIONS[kind] === null,
    );

    expect(unadvised).toEqual([]);
  });

  it('advises on no NON_BREAKING kind', () => {
    const advised = kinds.filter(
      (kind) => RULES[kind].severity === 'NON_BREAKING' && SUGGESTIONS[kind] !== null,
    );

    expect(advised).toEqual([]);
  });

  it('never restates the rule message it sits next to', () => {
    for (const kind of kinds) {
      const suggestion = suggestionFor(kind, { path: '/pets', method: 'get', field: ['tag'] });
      if (suggestion === undefined) continue;
      expect(suggestion, kind).not.toBe(RULES[kind].message);
    }
  });

  it('gives advice, not a description: every suggestion opens with a verb', () => {
    const openers = /^(Restore|Keep|Add|Give|Accept|Return)\b/;
    for (const kind of kinds) {
      const suggestion = suggestionFor(kind, { path: '/pets', method: 'get', field: ['tag'] });
      if (suggestion === undefined) continue;
      expect(suggestion, `${kind}: ${suggestion}`).toMatch(openers);
    }
  });
});

describe('suggestions through the real pipeline', () => {
  it('reaches every breaking finding of the fixture pair', async () => {
    const report = await detectDrift(fixture('petstore-old.yaml'), fixture('petstore-new.yaml'), {
      consumersDir: fixture('consumers'),
    });

    const breaking = report.differences.filter((d) => d.severity === 'BREAKING');
    expect(breaking).toHaveLength(9);
    expect(breaking.every((d) => d.suggestion !== undefined)).toBe(true);
  });

  it('leaves warnings and non-breaking findings without advice', async () => {
    const report = await detectDrift(fixture('petstore-old.yaml'), fixture('petstore-new.yaml'));

    const rest = report.differences.filter((d) => d.severity !== 'BREAKING');
    expect(rest.every((d) => d.suggestion === undefined)).toBe(true);
  });

  it('names the real field from the real diff, not a placeholder', async () => {
    const report = await detectDrift(fixture('petstore-old.yaml'), fixture('petstore-new.yaml'));

    const [species] = report.differences.filter((d) => d.location.endsWith('properties.species'));
    expect(species?.suggestion).toBe(
      'Add `species` as optional with a server-side default, and require it once senders have migrated.',
    );
  });
});
