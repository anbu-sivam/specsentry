import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConsumerManifests } from '../src/consumers.js';
import { loadSpec } from '../src/loader.js';
import { validateManifests } from '../src/validate.js';
import type { ConsumerManifest, ConsumerUsage, OpenApiSpec } from '../src/types.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const oldSpec = async () => (await loadSpec(fixture('petstore-old.yaml'))).spec;

function manifest(consumer: string, uses: Partial<ConsumerUsage>[]): ConsumerManifest {
  return {
    consumer,
    source: `memory/${consumer}.json`,
    uses: uses.map((usage) => ({
      path: usage.path ?? '/pets',
      method: usage.method ?? 'get',
      reads: usage.reads ?? [],
      sends: usage.sends ?? [],
    })),
  };
}

/** A spec with one endpoint that both takes and returns `schema`. */
function specWith(schema: unknown): OpenApiSpec {
  const body = { content: { 'application/json': { schema } } };
  return {
    openapi: '3.0.3',
    info: { title: 'Test', version: '1.0.0' },
    paths: { '/thing': { post: { requestBody: body, responses: { '200': body } } } },
  };
}

const messages = (problems: { message: string }[]) => problems.map((p) => p.message);

describe('validateManifests', () => {
  it('passes the manifests the impact tests rely on', async () => {
    // Pins the validator and the impact layer to the same idea of a field path.
    // Anything this rejects is something impact.ts could never have matched.
    const manifests = await loadConsumerManifests(fixture('consumers'));

    expect(validateManifests(manifests, await oldSpec())).toEqual([]);
  });

  it('passes an empty manifest set', async () => {
    expect(validateManifests([], await oldSpec())).toEqual([]);
  });

  it('accepts a field reached through an array, as a client addresses it', async () => {
    // /pets returns [Pet]; `id` is how a caller names it, never `items.id`.
    const usesArray = manifest('lister', [{ path: '/pets', method: 'get', reads: ['id'] }]);

    expect(validateManifests([usesArray], await oldSpec())).toEqual([]);
  });

  it('rejects the array hop spelled out, since no client addresses it that way', async () => {
    const spelledOut = manifest('lister', [{ path: '/pets', method: 'get', reads: ['items.id'] }]);

    expect(messages(validateManifests([spelledOut], await oldSpec()))).toEqual([
      expect.stringContaining('"items.id" is not in any response of get /pets'),
    ]);
  });
});

describe('validateManifests catches', () => {
  it('a path the spec does not have', async () => {
    const problems = validateManifests(
      [manifest('typo', [{ path: '/petz', method: 'get' }])],
      await oldSpec(),
    );

    expect(problems).toEqual([
      {
        consumer: 'typo',
        source: 'memory/typo.json',
        at: 'uses[0].path',
        message: '"/petz" is not a path in the spec',
      },
    ]);
  });

  it('a real method that this path does not define, and says which it does', async () => {
    const problems = validateManifests(
      [manifest('wrong', [{ path: '/pets', method: 'put' }])],
      await oldSpec(),
    );

    expect(problems[0]?.at).toBe('uses[0].method');
    expect(problems[0]?.message).toBe('"put" is not defined on "/pets" — it has: get, post');
  });

  it('a misspelled response field, and offers the real ones', async () => {
    const problems = validateManifests(
      [manifest('typo', [{ path: '/pets/{petId}', method: 'get', reads: ['nmae'] }])],
      await oldSpec(),
    );

    expect(problems[0]?.at).toBe('uses[0].reads[0]');
    expect(problems[0]?.message).toBe(
      '"nmae" is not in any response of get /pets/{petId} (available: id, name, status, tag)',
    );
  });

  it('a misspelled request field', async () => {
    const problems = validateManifests(
      [manifest('typo', [{ path: '/pets', method: 'post', sends: ['nme'] }])],
      await oldSpec(),
    );

    expect(problems[0]?.at).toBe('uses[0].sends[0]');
    expect(problems[0]?.message).toBe(
      '"nme" is not in the request body of post /pets (available: name, tag)',
    );
  });

  it('a field declared against an endpoint that takes no request body', async () => {
    const problems = validateManifests(
      [manifest('confused', [{ path: '/pets', method: 'get', sends: ['limit'] }])],
      await oldSpec(),
    );

    expect(problems[0]?.message).toBe('"limit" cannot be sent: get /pets takes no request body');
  });

  it('a field read from an endpoint that documents no response body', async () => {
    const problems = validateManifests(
      [manifest('confused', [{ path: '/pets/{petId}', method: 'delete', reads: ['id'] }])],
      await oldSpec(),
    );

    expect(problems[0]?.message).toBe(
      '"id" cannot be read: delete /pets/{petId} documents no response body',
    );
  });

  it('a field that exists only in the new spec, which nobody can be using yet', async () => {
    // NewPet.species arrives in petstore-new. Declaring it against the old
    // contract describes a future this consumer has not shipped.
    const problems = validateManifests(
      [manifest('early', [{ path: '/pets', method: 'post', sends: ['species'] }])],
      await oldSpec(),
    );

    expect(problems[0]?.message).toContain('"species" is not in the request body of post /pets');
  });
});

describe('validateManifests reports every problem', () => {
  it('across separate uses entries in one manifest', async () => {
    const problems = validateManifests(
      [
        manifest('confused', [
          { path: '/pets', method: 'get', reads: ['colour'] },
          { path: '/pets', method: 'post', sends: ['species'] },
          { path: '/nope', method: 'get' },
        ]),
      ],
      await oldSpec(),
    );

    expect(problems.map((p) => p.at)).toEqual([
      'uses[0].reads[0]',
      'uses[1].sends[0]',
      'uses[2].path',
    ]);
  });

  it('for several bad fields in a single entry', async () => {
    const problems = validateManifests(
      [manifest('typo', [{ path: '/pets/{petId}', method: 'get', reads: ['a', 'name', 'b'] }])],
      await oldSpec(),
    );

    expect(problems.map((p) => p.at)).toEqual(['uses[0].reads[0]', 'uses[0].reads[2]']);
  });

  it('across several manifests at once', async () => {
    const problems = validateManifests(
      [
        manifest('one', [{ path: '/nope', method: 'get' }]),
        manifest('two', [{ path: '/nah', method: 'get' }]),
      ],
      await oldSpec(),
    );

    expect(problems.map((p) => p.consumer)).toEqual(['one', 'two']);
  });

  it('but does not pile field errors on top of a bad path', async () => {
    // The fields are unknowable until the path is fixed, so reporting them
    // would bury the one line that needs changing.
    const problems = validateManifests(
      [manifest('typo', [{ path: '/petz', method: 'get', reads: ['a', 'b', 'c'] }])],
      await oldSpec(),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]?.at).toBe('uses[0].path');
  });

  it('but does not pile field errors on top of a bad method', async () => {
    const problems = validateManifests(
      [manifest('wrong', [{ path: '/pets', method: 'put', sends: ['x', 'y'] }])],
      await oldSpec(),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]?.at).toBe('uses[0].method');
  });
});

describe('validateManifests on nested schemas', () => {
  const nested = {
    type: 'object',
    properties: {
      owner: { type: 'object', properties: { name: { type: 'string' } } },
    },
  };

  it('accepts a leaf addressed through its parent', () => {
    const uses = manifest('nested', [{ path: '/thing', method: 'post', reads: ['owner.name'] }]);

    expect(validateManifests([uses], specWith(nested))).toEqual([]);
  });

  it('accepts the parent object on its own, which impact matching allows', () => {
    const uses = manifest('nested', [{ path: '/thing', method: 'post', reads: ['owner'] }]);

    expect(validateManifests([uses], specWith(nested))).toEqual([]);
  });

  it('rejects a leaf that is not under that parent', () => {
    const uses = manifest('nested', [{ path: '/thing', method: 'post', reads: ['owner.email'] }]);

    expect(messages(validateManifests([uses], specWith(nested)))).toEqual([
      '"owner.email" is not in any response of post /thing (available: owner, owner.name)',
    ]);
  });

  it('accepts a path through a self-referencing schema', () => {
    // Dereferencing makes this a real object cycle, so `child.child.name` is
    // genuinely addressable. Validity is decided by following the declared
    // path, not by enumerating a schema that has infinitely many.
    const cyclic: Record<string, unknown> = { type: 'object', properties: { name: { type: 'string' } } };
    (cyclic.properties as Record<string, unknown>).child = cyclic;

    const uses = manifest('nested', [
      { path: '/thing', method: 'post', reads: ['child.name', 'child.child.name'] },
    ]);

    expect(validateManifests([uses], specWith(cyclic))).toEqual([]);
  });

  it('still rejects a bad leaf beneath a cycle', () => {
    const cyclic: Record<string, unknown> = { type: 'object', properties: { name: { type: 'string' } } };
    (cyclic.properties as Record<string, unknown>).child = cyclic;

    const uses = manifest('nested', [{ path: '/thing', method: 'post', reads: ['child.nmae'] }]);

    expect(messages(validateManifests([uses], specWith(cyclic)))).toEqual([
      expect.stringContaining('"child.nmae" is not in any response of post /thing'),
    ]);
  });
});
