import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/classifier.js';
import { diffSpecs } from '../src/differ.js';
import { attributeConsumers } from '../src/impact.js';
import { loadSpec } from '../src/loader.js';
import { RULES } from '../src/rules.js';
import type { ConsumerManifest, ConsumerUsage, LoadedSpec, OpenApiSpec } from '../src/types.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** Every consumer named against each location, for the real fixture pair. */
async function attributeFixtures(manifests: ConsumerManifest[]) {
  const [oldSpec, newSpec] = await Promise.all([
    loadSpec(fixture('petstore-old.yaml')),
    loadSpec(fixture('petstore-new.yaml')),
  ]);
  return attributeConsumers(classify(diffSpecs(oldSpec, newSpec)), manifests);
}

function manifest(consumer: string, uses: Partial<ConsumerUsage>[]): ConsumerManifest {
  return {
    consumer,
    source: `memory/${consumer}.json`,
    uses: uses.map((usage) => ({
      path: usage.path ?? '/thing',
      method: usage.method ?? 'post',
      reads: usage.reads ?? [],
      sends: usage.sends ?? [],
    })),
  };
}

function spec(paths: Record<string, unknown>): LoadedSpec {
  const document: OpenApiSpec = {
    openapi: '3.0.3',
    info: { title: 'Test', version: '1.0.0' },
    paths,
  };
  return { source: 'memory', spec: document };
}

const jsonBody = (schema: unknown) => ({ content: { 'application/json': { schema } } });

/** POST /thing that both sends and returns `schema`, so one edit hits both sides. */
const echo = (schema: unknown) => ({
  '/thing': { post: { requestBody: jsonBody(schema), responses: { '200': jsonBody(schema) } } },
});

function attribute(before: unknown, after: unknown, manifests: ConsumerManifest[]) {
  const differences = classify(diffSpecs(spec(echo(before)), spec(echo(after))));
  return attributeConsumers(differences, manifests);
}

const consumersAt = (differences: { location: string; consumers: string[] }[], match: string) =>
  differences.filter((d) => d.location.includes(match)).flatMap((d) => d.consumers);

describe('attributeConsumers against the petstore fixtures', () => {
  const manifests = [
    manifest('checkout-service', [
      { path: '/pets/{petId}', method: 'get', reads: ['id', 'name', 'tag'] },
      { path: '/pets/{petId}', method: 'delete' },
    ]),
    manifest('inventory-service', [
      { path: '/pets', method: 'get', reads: ['id', 'status'] },
      { path: '/pets', method: 'post', sends: ['name'], reads: ['id'] },
    ]),
    manifest('reporting-service', [{ path: '/pets/{petId}', method: 'get', reads: ['name'] }]),
  ];

  it('names a consumer for exactly the changes that reach it', async () => {
    const differences = await attributeFixtures(manifests);

    const attributed = differences
      .filter((difference) => difference.consumers.length > 0)
      .map((difference) => `${difference.location} -> ${difference.consumers.join(', ')}`)
      .sort();

    expect(attributed).toEqual(
      [
        'paths./pets.get.parameters.query.limit -> inventory-service',
        'paths./pets.get.responses.200.content.application/json.schema.items.properties.id -> inventory-service',
        'paths./pets.get.responses.200.content.application/json.schema.items.properties.status -> inventory-service',
        'paths./pets.post.requestBody.content.application/json.schema.properties.species -> inventory-service',
        'paths./pets.post.responses.201.content.application/json.schema.properties.id -> inventory-service',
        'paths./pets/{petId}.delete -> checkout-service',
        'paths./pets/{petId}.get -> checkout-service, reporting-service',
        'paths./pets/{petId}.get.responses.200.content.application/json.schema.properties.id -> checkout-service',
        'paths./pets/{petId}.get.responses.200.content.application/json.schema.properties.tag -> checkout-service',
      ].sort(),
    );
  });

  it('blames the new required field on the consumer that never sent it', async () => {
    const differences = await attributeFixtures(manifests);

    // inventory-service declares sends: ['name'] and cannot have declared a
    // field that did not exist. It is affected precisely because it omits it.
    const [species] = differences.filter((d) => d.location.endsWith('properties.species'));

    expect(species?.kind).toBe('request.property.added.required');
    expect(species?.consumers).toEqual(['inventory-service']);
  });

  it('leaves a removed field unattributed when no consumer reads it there', async () => {
    const differences = await attributeFixtures(manifests);

    // Pet.tag goes on all three endpoints that return it, but only the
    // /pets/{petId} reader declared tag.
    expect(consumersAt(differences, '/pets.get.responses.200')).not.toContain('checkout-service');
    expect(
      differences
        .filter((d) => d.location === 'paths./pets.get.responses.200.content.application/json.schema.items.properties.tag')
        .flatMap((d) => d.consumers),
    ).toEqual([]);
  });

  it('spares a consumer that reads none of the fields that drifted', async () => {
    const differences = await attributeFixtures(manifests);

    const reporting = differences.filter((d) => d.consumers.includes('reporting-service'));

    // It reads only Pet.name, which did not move, so the deprecation of the
    // endpoint it calls is the sole thing that reaches it.
    expect(reporting.map((d) => `${d.severity} ${d.kind}`)).toEqual(['WARNING operation.deprecated']);
  });

  it('attributes nothing when no manifests are loaded', async () => {
    const differences = await attributeFixtures([]);

    expect(differences.every((difference) => difference.consumers.length === 0)).toBe(true);
  });

  it('keeps every consumer list sorted and free of duplicates', async () => {
    const differences = await attributeFixtures(manifests);

    for (const { consumers } of differences) {
      expect(consumers).toEqual([...consumers].sort());
      expect(new Set(consumers).size).toBe(consumers.length);
    }
  });
});

describe('direction', () => {
  const before = { type: 'object', properties: { id: { type: 'string' } } };
  const after = { type: 'object', properties: { id: { type: 'integer' } } };

  it('matches a response change against what a consumer reads', () => {
    const reader = manifest('reader', [{ path: '/thing', method: 'post', reads: ['id'] }]);

    const differences = attribute(before, after, [reader]);

    expect(consumersAt(differences, 'responses.200')).toEqual(['reader']);
    expect(consumersAt(differences, 'requestBody')).toEqual([]);
  });

  it('matches a request change against what a consumer sends', () => {
    const sender = manifest('sender', [{ path: '/thing', method: 'post', sends: ['id'] }]);

    const differences = attribute(before, after, [sender]);

    expect(consumersAt(differences, 'requestBody')).toEqual(['sender']);
    expect(consumersAt(differences, 'responses.200')).toEqual([]);
  });
});

describe('endpoint matching', () => {
  it('ignores a consumer of a different method on the same path', () => {
    const differences = classify(
      diffSpecs(spec({ '/thing': { get: {}, delete: {} } }), spec({ '/thing': { get: {} } })),
    );

    const attributed = attributeConsumers(differences, [
      manifest('deleter', [{ path: '/thing', method: 'delete' }]),
      manifest('getter', [{ path: '/thing', method: 'get' }]),
    ]);

    expect(attributed.map((d) => `${d.kind} -> ${d.consumers.join(',')}`)).toEqual([
      'method.removed -> deleter',
    ]);
  });

  it('sweeps up every method when the whole path goes', () => {
    const differences = classify(diffSpecs(spec({ '/thing': { get: {}, post: {} } }), spec({})));

    const attributed = attributeConsumers(differences, [
      manifest('getter', [{ path: '/thing', method: 'get' }]),
      manifest('poster', [{ path: '/thing', method: 'post' }]),
      manifest('stranger', [{ path: '/other', method: 'get' }]),
    ]);

    expect(attributed).toHaveLength(1);
    expect(attributed[0]).toMatchObject({ kind: 'path.removed', consumers: ['getter', 'poster'] });
  });
});

describe('nested fields', () => {
  const withOwner = (nameType: string) => ({
    type: 'object',
    properties: {
      owner: { type: 'object', properties: { name: { type: nameType }, city: { type: 'string' } } },
    },
  });

  it('reaches a consumer that declared the parent object', () => {
    const differences = attribute(withOwner('string'), withOwner('integer'), [
      manifest('parent-reader', [{ path: '/thing', method: 'post', reads: ['owner'] }]),
    ]);

    expect(consumersAt(differences, 'responses.200')).toEqual(['parent-reader']);
  });

  it('reaches a consumer that declared the leaf when an ancestor is removed', () => {
    const before = withOwner('string');
    const after = { type: 'object', properties: {} };

    const differences = attribute(before, after, [
      manifest('leaf-reader', [{ path: '/thing', method: 'post', reads: ['owner.name'] }]),
      manifest('other-reader', [{ path: '/thing', method: 'post', reads: ['tag'] }]),
    ]);

    expect(consumersAt(differences, 'responses.200')).toEqual(['leaf-reader']);
  });

  it('does not confuse a field with one that merely shares a prefix', () => {
    const before = { type: 'object', properties: { owner: { type: 'string' } } };
    const after = { type: 'object', properties: {} };

    const differences = attribute(before, after, [
      manifest('own-reader', [{ path: '/thing', method: 'post', reads: ['own'] }]),
    ]);

    expect(consumersAt(differences, 'responses.200')).toEqual([]);
  });

  it('treats a declared parent as no proof the payload carries a newly required leaf', () => {
    const optional = {
      type: 'object',
      properties: { owner: { type: 'object', properties: { email: { type: 'string' } } } },
    };
    const required = {
      type: 'object',
      properties: {
        owner: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
      },
    };

    const differences = attribute(optional, required, [
      manifest('parent-sender', [{ path: '/thing', method: 'post', sends: ['owner'] }]),
      manifest('leaf-sender', [{ path: '/thing', method: 'post', sends: ['owner.email'] }]),
    ]);

    // Sending `owner` says nothing about whether that object carries `email`,
    // so only the consumer that named the leaf is known to be safe.
    expect(consumersAt(differences, 'requestBody')).toEqual(['parent-sender']);
  });
});

describe('impact scopes', () => {
  it('gives every rule a scope, so a new kind cannot go unattributed', () => {
    for (const [kind, rule] of Object.entries(RULES)) {
      expect(
        ['none', 'endpoint', 'field.declared', 'field.omitted'],
        `${kind} impact`,
      ).toContain(rule.impact);
    }
  });

  it('never attributes a consumer to an additive change', () => {
    const before = { type: 'object', properties: { id: { type: 'string' } } };
    const after = {
      type: 'object',
      properties: { id: { type: 'string' }, extra: { type: 'string' } },
    };

    const differences = attribute(before, after, [
      manifest('everything', [{ path: '/thing', method: 'post', reads: ['id'], sends: ['id'] }]),
    ]);

    // The response gains a field the consumer ignores; the request gains an
    // optional one it need not send. Neither reaches anybody.
    expect(differences.flatMap((d) => d.consumers)).toEqual([]);
  });
});
