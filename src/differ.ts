import type { LoadedSpec, RawDifference } from './types.js';

/**
 * Walk two dereferenced specs and report every structural difference.
 *
 * STUB: returns a fixed sample of differences so the pipeline runs end to end.
 * The real implementation will compare, in roughly this order:
 *   1. info.version
 *   2. paths present/absent on either side
 *   3. methods per shared path
 *   4. parameters per shared operation (name+in is the identity)
 *   5. requestBody schemas, recursively
 *   6. response status codes, and each status's schema, recursively
 *
 * It should stay judgement-free: emit DiffKinds and locations only, and leave
 * every severity call to the rules table.
 */
export function diffSpecs(oldSpec: LoadedSpec, newSpec: LoadedSpec): RawDifference[] {
  void oldSpec;
  void newSpec;

  return [
    {
      kind: 'path.added',
      location: 'paths./health',
      after: { get: { summary: 'Liveness probe' } },
    },
    {
      kind: 'param.added.required',
      location: 'paths./users.get.parameters.tenantId',
      after: { name: 'tenantId', in: 'query', required: true },
    },
    {
      kind: 'schema.property.removed',
      location: 'paths./users/{id}.get.responses.200.schema.properties.legacyName',
      before: { type: 'string' },
    },
    {
      kind: 'operation.deprecated',
      location: 'paths./users/{id}.get',
      before: { deprecated: false },
      after: { deprecated: true },
    },
  ];
}
