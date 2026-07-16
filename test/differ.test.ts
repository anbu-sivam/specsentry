import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { diffSpecs } from '../src/differ.js';
import { loadSpec } from '../src/loader.js';
import { RULES } from '../src/rules.js';
import type { LoadedSpec, OpenApiSpec, RawDifference } from '../src/types.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const loadFixturePair = async () =>
  Promise.all([loadSpec(fixture('petstore-old.yaml')), loadSpec(fixture('petstore-new.yaml'))]);

/** Build a spec around a single operation, skipping the loader and its $refs. */
function spec(paths: Record<string, unknown>): LoadedSpec {
  const document: OpenApiSpec = {
    openapi: '3.0.3',
    info: { title: 'Test', version: '1.0.0' },
    paths,
  };
  return { source: 'memory', spec: document };
}

const jsonBody = (schema: unknown) => ({ content: { 'application/json': { schema } } });

/** An operation that sends `schema` and returns it, so one edit can be read from both sides. */
const echo = (schema: unknown) => ({
  '/thing': { post: { requestBody: jsonBody(schema), responses: { '200': jsonBody(schema) } } },
});

const kindsAt = (differences: RawDifference[], location: string) =>
  differences.filter((d) => d.location === location).map((d) => d.kind);

describe('diffSpecs against the petstore fixtures', () => {
  it('finds every documented drift and nothing else', async () => {
    const [oldSpec, newSpec] = await loadFixturePair();

    const found = diffSpecs(oldSpec, newSpec).map((d) => `${d.kind} ${d.location}`).sort();

    expect(found).toEqual(
      [
        'info.version.changed info.version',
        'method.removed paths./pets/{petId}.delete',
        'operation.deprecated paths./pets/{petId}.get',
        'param.added.optional paths./pets.get.parameters.query.sort',
        'param.required.tightened paths./pets.get.parameters.query.limit',
        'path.added paths./health',
        'request.property.added.required paths./pets.post.requestBody.content.application/json.schema.properties.species',
        'response.enum.value.added paths./pets.get.responses.200.content.application/json.schema.items.properties.status',
        'response.enum.value.added paths./pets.post.responses.201.content.application/json.schema.properties.status',
        'response.enum.value.added paths./pets/{petId}.get.responses.200.content.application/json.schema.properties.status',
        'response.property.removed paths./pets.get.responses.200.content.application/json.schema.items.properties.tag',
        'response.property.removed paths./pets.post.responses.201.content.application/json.schema.properties.tag',
        'response.property.removed paths./pets/{petId}.get.responses.200.content.application/json.schema.properties.tag',
        'response.property.type.changed paths./pets.get.responses.200.content.application/json.schema.items.properties.id',
        'response.property.type.changed paths./pets.post.responses.201.content.application/json.schema.properties.id',
        'response.property.type.changed paths./pets/{petId}.get.responses.200.content.application/json.schema.properties.id',
        'response.status.added paths./pets.get.responses.429',
      ].sort(),
    );
  });

  it('descends through array items to reach the element schema', async () => {
    const [oldSpec, newSpec] = await loadFixturePair();

    // /pets get returns an array of Pet, so Pet's drift only shows up under .items.
    expect(
      kindsAt(
        diffSpecs(oldSpec, newSpec),
        'paths./pets.get.responses.200.content.application/json.schema.items.properties.id',
      ),
    ).toEqual(['response.property.type.changed']);
  });

  it('reports the old and new type on a type change', async () => {
    const [oldSpec, newSpec] = await loadFixturePair();

    const [change] = diffSpecs(oldSpec, newSpec).filter(
      (d) => d.location === 'paths./pets/{petId}.get.responses.200.content.application/json.schema.properties.id',
    );

    expect(change).toMatchObject({ before: 'string', after: 'integer' });
  });

  it('names the endpoint and field of a response change in its target', async () => {
    const [oldSpec, newSpec] = await loadFixturePair();

    const [tag] = diffSpecs(oldSpec, newSpec).filter(
      (d) => d.location === 'paths./pets/{petId}.get.responses.200.content.application/json.schema.properties.tag',
    );

    expect(tag?.target).toEqual({
      path: '/pets/{petId}',
      method: 'get',
      direction: 'response',
      field: ['tag'],
    });
  });

  it('elides the array hop from the field path but not the location', async () => {
    const [oldSpec, newSpec] = await loadFixturePair();

    // /pets returns an array of Pet. A client addresses the field as `tag`;
    // only the document nests it under `items`.
    const [tag] = diffSpecs(oldSpec, newSpec).filter(
      (d) => d.location === 'paths./pets.get.responses.200.content.application/json.schema.items.properties.tag',
    );

    expect(tag?.target?.field).toEqual(['tag']);
  });

  it('gives a request body change the request direction', async () => {
    const [oldSpec, newSpec] = await loadFixturePair();

    const [species] = diffSpecs(oldSpec, newSpec).filter((d) => d.location.endsWith('properties.species'));

    expect(species?.target).toEqual({
      path: '/pets',
      method: 'post',
      direction: 'request',
      field: ['species'],
    });
  });

  it('names the parameter, and gives it no field, having no body field to name', async () => {
    const [oldSpec, newSpec] = await loadFixturePair();

    const [limit] = diffSpecs(oldSpec, newSpec).filter(
      (d) => d.location === 'paths./pets.get.parameters.query.limit',
    );

    expect(limit?.target).toEqual({ path: '/pets', method: 'get', parameter: 'limit' });
  });

  it('gives every endpoint change a target the cross-reference can match', async () => {
    const [oldSpec, newSpec] = await loadFixturePair();

    for (const difference of diffSpecs(oldSpec, newSpec)) {
      if (difference.location === 'info.version') {
        expect(difference.target).toBeUndefined();
        continue;
      }
      expect(difference.target?.path, difference.location).toBeDefined();
    }
  });

  it('emits only kinds the rules table can classify', async () => {
    const [oldSpec, newSpec] = await loadFixturePair();

    for (const difference of diffSpecs(oldSpec, newSpec)) {
      expect(RULES[difference.kind], `unknown kind: ${difference.kind}`).toBeDefined();
      expect(difference.location).not.toBe('');
    }
  });

  it('finds nothing when a spec is compared against itself', async () => {
    const [oldSpec] = await loadFixturePair();

    expect(diffSpecs(oldSpec, oldSpec)).toEqual([]);
  });
});

describe('request and response directions', () => {
  it('names the same added required property differently on each side', () => {
    const before = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
    const after = {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
      required: ['id', 'name'],
    };

    const differences = diffSpecs(spec(echo(before)), spec(echo(after)));

    expect(kindsAt(differences, 'paths./thing.post.requestBody.content.application/json.schema.properties.name')).toEqual([
      'request.property.added.required',
    ]);
    expect(kindsAt(differences, 'paths./thing.post.responses.200.content.application/json.schema.properties.name')).toEqual([
      'response.property.added',
    ]);
  });

  it('names a removed property differently on each side', () => {
    const before = { type: 'object', properties: { id: { type: 'string' }, tag: { type: 'string' } } };
    const after = { type: 'object', properties: { id: { type: 'string' } } };

    const differences = diffSpecs(spec(echo(before)), spec(echo(after)));

    expect(kindsAt(differences, 'paths./thing.post.requestBody.content.application/json.schema.properties.tag')).toEqual([
      'request.property.removed',
    ]);
    expect(kindsAt(differences, 'paths./thing.post.responses.200.content.application/json.schema.properties.tag')).toEqual([
      'response.property.removed',
    ]);
  });

  it('names an added enum value differently on each side', () => {
    const before = { type: 'object', properties: { status: { type: 'string', enum: ['a'] } } };
    const after = { type: 'object', properties: { status: { type: 'string', enum: ['a', 'b'] } } };

    const differences = diffSpecs(spec(echo(before)), spec(echo(after)));

    expect(kindsAt(differences, 'paths./thing.post.requestBody.content.application/json.schema.properties.status')).toEqual([
      'request.enum.value.added',
    ]);
    expect(kindsAt(differences, 'paths./thing.post.responses.200.content.application/json.schema.properties.status')).toEqual([
      'response.enum.value.added',
    ]);
  });

  it('splits required-ness changes by side, so the rules can score them oppositely', () => {
    const before = { type: 'object', properties: { name: { type: 'string' } }, required: [] };
    const after = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };

    const differences = diffSpecs(spec(echo(before)), spec(echo(after)));

    expect(kindsAt(differences, 'paths./thing.post.requestBody.content.application/json.schema.properties.name')).toEqual([
      'request.property.required.tightened',
    ]);
    expect(kindsAt(differences, 'paths./thing.post.responses.200.content.application/json.schema.properties.name')).toEqual([
      'response.property.required.tightened',
    ]);
    expect(RULES['request.property.required.tightened'].severity).toBe('BREAKING');
    expect(RULES['response.property.required.tightened'].severity).toBe('NON_BREAKING');
  });

  it('reports a removed enum value on each side', () => {
    const before = { type: 'object', properties: { status: { type: 'string', enum: ['a', 'b'] } } };
    const after = { type: 'object', properties: { status: { type: 'string', enum: ['a'] } } };

    const differences = diffSpecs(spec(echo(before)), spec(echo(after)));

    expect(kindsAt(differences, 'paths./thing.post.requestBody.content.application/json.schema.properties.status')).toEqual([
      'request.enum.value.removed',
    ]);
    expect(kindsAt(differences, 'paths./thing.post.responses.200.content.application/json.schema.properties.status')).toEqual([
      'response.enum.value.removed',
    ]);
  });

  it('ignores an enum appearing where there was none, rather than calling it an addition', () => {
    const before = { type: 'object', properties: { status: { type: 'string' } } };
    const after = { type: 'object', properties: { status: { type: 'string', enum: ['a'] } } };

    expect(diffSpecs(spec(echo(before)), spec(echo(after)))).toEqual([]);
  });
});

describe('endpoint surface', () => {
  it('reports a removed path once, without itemising what it took with it', () => {
    const before = spec({
      '/gone': {
        get: { parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }], responses: { '200': {} } },
      },
    });

    const differences = diffSpecs(before, spec({}));

    expect(differences).toEqual([
      {
        kind: 'path.removed',
        location: 'paths./gone',
        target: { path: '/gone' },
        before: { methods: ['get'] },
      },
    ]);
  });

  it('reports a removed method once, without itemising its parameters', () => {
    const operation = {
      operationId: 'drop',
      parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
      responses: { '200': {} },
    };

    const differences = diffSpecs(spec({ '/thing': { get: {}, delete: operation } }), spec({ '/thing': { get: {} } }));

    expect(differences).toEqual([
      {
        kind: 'method.removed',
        location: 'paths./thing.delete',
        target: { path: '/thing', method: 'delete' },
        before: { operationId: 'drop' },
      },
    ]);
  });

  it('reports added and removed status codes per operation', () => {
    const differences = diffSpecs(
      spec({ '/thing': { get: { responses: { '200': {}, '404': {} } } } }),
      spec({ '/thing': { get: { responses: { '200': {}, '429': {} } } } }),
    );

    expect(differences.map((d) => `${d.kind} ${d.location}`)).toEqual([
      'response.status.removed paths./thing.get.responses.404',
      'response.status.added paths./thing.get.responses.429',
    ]);
  });
});

describe('parameters', () => {
  const withParams = (parameters: unknown[]) => ({ '/thing': { get: { parameters, responses: {} } } });

  it('identifies a parameter by name and location together', () => {
    const differences = diffSpecs(
      spec(withParams([{ name: 'id', in: 'query', schema: { type: 'string' } }])),
      spec(withParams([{ name: 'id', in: 'header', schema: { type: 'string' } }])),
    );

    expect(differences.map((d) => `${d.kind} ${d.location}`)).toEqual([
      'param.removed paths./thing.get.parameters.query.id',
      'param.added.optional paths./thing.get.parameters.header.id',
    ]);
  });

  it('names a parameter type change in the vocabulary of parameters', () => {
    const differences = diffSpecs(
      spec(withParams([{ name: 'limit', in: 'query', schema: { type: 'string' } }])),
      spec(withParams([{ name: 'limit', in: 'query', schema: { type: 'integer' } }])),
    );

    expect(differences).toEqual([
      {
        kind: 'param.type.changed',
        location: 'paths./thing.get.parameters.query.limit',
        target: {
          path: '/thing',
          method: 'get',
          parameter: 'limit',
          direction: 'request',
          field: undefined,
        },
        before: 'string',
        after: 'integer',
      },
    ]);
  });

  it('treats an enum inside a parameter as request-side', () => {
    const differences = diffSpecs(
      spec(withParams([{ name: 'sort', in: 'query', schema: { type: 'string', enum: ['asc'] } }])),
      spec(withParams([{ name: 'sort', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } }])),
    );

    expect(differences.map((d) => d.kind)).toEqual(['request.enum.value.added']);
  });

  it('carries the parameter name into findings from its own schema', () => {
    const differences = diffSpecs(
      spec(withParams([{ name: 'sort', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } }])),
      spec(withParams([{ name: 'sort', in: 'query', schema: { type: 'string', enum: ['asc'] } }])),
    );

    // The value dropped is on `before`, where every enum finding carries it.
    expect(differences[0]).toMatchObject({
      kind: 'request.enum.value.removed',
      target: { parameter: 'sort' },
      before: 'desc',
    });
  });

  it('merges path-level parameters into each operation', () => {
    const before = spec({
      '/thing': { parameters: [{ name: 'tenant', in: 'query', required: false, schema: { type: 'string' } }], get: { responses: {} } },
    });
    const after = spec({
      '/thing': { parameters: [{ name: 'tenant', in: 'query', required: true, schema: { type: 'string' } }], get: { responses: {} } },
    });

    expect(diffSpecs(before, after)).toEqual([
      {
        kind: 'param.required.tightened',
        location: 'paths./thing.get.parameters.query.tenant',
        target: { path: '/thing', method: 'get', parameter: 'tenant' },
        before: false,
        after: true,
      },
    ]);
  });

  it('lets an operation-level parameter override the path-level one it shadows', () => {
    const pathLevel = [{ name: 'tenant', in: 'query', required: true, schema: { type: 'string' } }];
    const before = spec({ '/thing': { parameters: pathLevel, get: { responses: {} } } });
    const after = spec({
      '/thing': {
        parameters: pathLevel,
        get: { parameters: [{ name: 'tenant', in: 'query', required: false, schema: { type: 'string' } }], responses: {} },
      },
    });

    expect(diffSpecs(before, after)).toEqual([
      {
        kind: 'param.required.loosened',
        location: 'paths./thing.get.parameters.query.tenant',
        target: { path: '/thing', method: 'get', parameter: 'tenant' },
        before: true,
        after: false,
      },
    ]);
  });
});

describe('cyclic schemas', () => {
  /** What the loader hands back for a schema whose $ref points at itself. */
  function selfReferencing(leafType: string) {
    const node: Record<string, unknown> = { type: 'object', properties: { name: { type: leafType } } };
    (node.properties as Record<string, unknown>).child = node;
    return node;
  }

  it('terminates and still reports the change beneath the cycle', () => {
    const differences = diffSpecs(spec(echo(selfReferencing('string'))), spec(echo(selfReferencing('integer'))));

    expect(kindsAt(differences, 'paths./thing.post.responses.200.content.application/json.schema.properties.name')).toEqual([
      'response.property.type.changed',
    ]);
  });

  it('produces a report that survives JSON serialisation', () => {
    const differences = diffSpecs(spec(echo(selfReferencing('string'))), spec(echo(selfReferencing('integer'))));

    expect(() => JSON.stringify(differences)).not.toThrow();
  });
});
