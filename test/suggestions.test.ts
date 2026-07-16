import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectDrift } from '../src/index.js';
import { RULES } from '../src/rules.js';
import { SUGGESTIONS, suggestionFor } from '../src/suggestions.js';
import type { DiffKind, DiffTarget, RawDifference } from '../src/types.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const kinds = Object.keys(RULES) as DiffKind[];

/** A finding of `kind`, with only the parts a suggestion reads. */
function finding(kind: DiffKind, target?: DiffTarget, rest: Partial<RawDifference> = {}) {
  return { kind, location: 'test', target, ...rest };
}

describe('suggestionFor names the thing that changed', () => {
  it('tells you to restore a removed method, by name', () => {
    const suggestion = suggestionFor(
      finding('method.removed', { path: '/pets/{petId}', method: 'delete' }),
    );

    expect(suggestion).toBe(
      'Restore DELETE /pets/{petId} and mark it deprecated, or move the removal to a new API version.',
    );
  });

  it('omits the method for a removed path, which took every method with it', () => {
    const suggestion = suggestionFor(finding('path.removed', { path: '/pets' }));

    expect(suggestion).toBe(
      'Restore /pets and mark it deprecated, or move the removal to a new API version.',
    );
  });

  it('tells you to default a newly required request field, by name', () => {
    const suggestion = suggestionFor(
      finding('request.property.added.required', {
        path: '/pets',
        method: 'post',
        direction: 'request',
        field: ['species'],
      }),
    );

    expect(suggestion).toBe(
      'Add `species` as optional with a server-side default, and require it once senders have migrated.',
    );
  });

  it('tells you to keep returning a removed response field, by name', () => {
    const suggestion = suggestionFor(
      finding('response.property.removed', {
        path: '/pets/{petId}',
        method: 'get',
        direction: 'response',
        field: ['tag'],
      }),
    );

    expect(suggestion).toBe(
      'Keep returning `tag` for a deprecation cycle, then drop it in a new API version.',
    );
  });

  it('addresses a nested field the way a client writes it', () => {
    const suggestion = suggestionFor(
      finding('response.property.removed', { field: ['owner', 'name'] }),
    );

    expect(suggestion).toContain('`owner.name`');
  });

  it('gives opposite advice for the same edit on each side of the wire', () => {
    const request = suggestionFor(finding('request.property.type.changed', { field: ['id'] }));
    const response = suggestionFor(finding('response.property.type.changed', { field: ['id'] }));

    // A sender needs the server to accept both; a reader needs the old field
    // left alone. Same structural edit, different fix.
    expect(request).toContain('Accept both the old and the new type');
    expect(response).toContain('Return the new type in a new field');
    expect(request).not.toBe(response);
  });
});

describe('suggestionFor names the parameter', () => {
  const limit: DiffTarget = { path: '/pets', method: 'get', parameter: 'limit' };

  it('when it is newly required', () => {
    expect(suggestionFor(finding('param.required.tightened', limit))).toBe(
      'Keep `limit` optional and default it server-side; require it only in a new API version.',
    );
  });

  it('when it is newly added and required', () => {
    expect(suggestionFor(finding('param.added.required', limit))).toBe(
      'Give `limit` a server-side default and keep it optional; require it only in a new API version.',
    );
  });

  it('when its type changed', () => {
    expect(suggestionFor(finding('param.type.changed', limit))).toBe(
      'Accept both the old and the new type for `limit`, or take the new type as a separate parameter.',
    );
  });

  it('falling back only when the parameter is genuinely unnamed', () => {
    expect(suggestionFor(finding('param.required.tightened', { path: '/pets', method: 'get' }))).toBe(
      'Keep the parameter optional and default it server-side; require it only in a new API version.',
    );
  });
});

describe('suggestionFor names the enum value', () => {
  it('reading it from the finding rather than a copy on the target', () => {
    const suggestion = suggestionFor(
      finding('request.enum.value.removed', { field: ['status'] }, { before: 'sold' }),
    );

    expect(suggestion).toBe(
      'Keep accepting `sold` for `status` and map it to its replacement, or reject it only in a new API version.',
    );
  });

  it('printing a non-string value as it appears in the document', () => {
    const suggestion = suggestionFor(
      finding('request.enum.value.removed', { field: ['tier'] }, { before: 3 }),
    );

    expect(suggestion).toContain('Keep accepting `3` for `tier`');
  });

  it('naming the parameter when the enum lives inside one', () => {
    // A parameter's schema has no body field, so the parameter is the subject.
    const suggestion = suggestionFor(
      finding(
        'request.enum.value.removed',
        { path: '/pets', method: 'get', parameter: 'sort' },
        { before: 'desc' },
      ),
    );

    expect(suggestion).toContain('Keep accepting `desc` for `sort`');
  });

  it('falling back when the value is somehow absent', () => {
    expect(suggestionFor(finding('request.enum.value.removed', { field: ['status'] }))).toContain(
      'Keep accepting the dropped value for `status`',
    );
  });
});

describe('suggestionFor stays silent', () => {
  it('for an additive change', () => {
    expect(suggestionFor(finding('path.added', { path: '/health' }))).toBeUndefined();
    expect(suggestionFor(finding('response.property.added', { field: ['nickname'] }))).toBeUndefined();
  });

  it('for a change that loosens a constraint', () => {
    expect(suggestionFor(finding('param.required.loosened', { path: '/pets' }))).toBeUndefined();
  });

  it('for the version bump', () => {
    expect(suggestionFor(finding('info.version.changed'))).toBeUndefined();
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
      const suggestion = suggestionFor(finding(kind, { path: '/pets', method: 'get', field: ['tag'] }));
      if (suggestion === undefined) continue;
      expect(suggestion, kind).not.toBe(RULES[kind].message);
    }
  });

  it('gives advice, not a description: every suggestion opens with a verb', () => {
    const openers = /^(Restore|Keep|Add|Give|Accept|Return)\b/;
    for (const kind of kinds) {
      const suggestion = suggestionFor(finding(kind, { path: '/pets', method: 'get', field: ['tag'] }));
      if (suggestion === undefined) continue;
      expect(suggestion, `${kind}: ${suggestion}`).toMatch(openers);
    }
  });

  it('leaves no placeholder wording in any BREAKING advice for a fully named target', () => {
    const target: DiffTarget = {
      path: '/pets',
      method: 'get',
      parameter: 'limit',
      field: ['tag'],
    };

    for (const kind of kinds.filter((k) => RULES[k].severity === 'BREAKING')) {
      const suggestion = suggestionFor(finding(kind, target, { before: 'sold' }));
      expect(suggestion, kind).not.toContain('the parameter');
      expect(suggestion, kind).not.toContain('the property');
      expect(suggestion, kind).not.toContain('the dropped value');
      expect(suggestion, kind).not.toContain('this endpoint');
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

  it('names the real parameter from the real diff', async () => {
    const report = await detectDrift(fixture('petstore-old.yaml'), fixture('petstore-new.yaml'));

    const [limit] = report.differences.filter((d) => d.kind === 'param.required.tightened');
    expect(limit?.target?.parameter).toBe('limit');
    expect(limit?.suggestion).toBe(
      'Keep `limit` optional and default it server-side; require it only in a new API version.',
    );
  });

  it('leaves no BREAKING finding of the fixture pair advised in the abstract', async () => {
    const report = await detectDrift(fixture('petstore-old.yaml'), fixture('petstore-new.yaml'));

    for (const difference of report.differences.filter((d) => d.severity === 'BREAKING')) {
      expect(difference.suggestion, difference.location).not.toContain('the parameter');
      expect(difference.suggestion, difference.location).not.toContain('the property');
    }
  });
});
