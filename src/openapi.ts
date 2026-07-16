/**
 * The shape of an OpenAPI document, and the small accessors for reading one.
 *
 * Deliberately structural and loose. The loader hands back a dereferenced
 * document that a real spec may not honour in every detail, so everything here
 * reads defensively rather than trusting the declared types.
 *
 * Shared so the differ and the manifest validator cannot drift apart about what
 * a schema is: a field the validator rejects is one the impact layer would
 * never match, and that disagreement would be invisible.
 */
import { HTTP_METHODS } from './types.js';
import type { HttpMethod, OpenApiSpec } from './types.js';

export interface SchemaObject {
  type?: string | string[];
  properties?: Record<string, SchemaObject>;
  required?: string[];
  items?: SchemaObject;
  enum?: unknown[];
  [key: string]: unknown;
}

export interface ParameterObject {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: SchemaObject;
  [key: string]: unknown;
}

export interface MediaTypeObject {
  schema?: SchemaObject;
  [key: string]: unknown;
}

/** Anything with a `content` map: a Request Body Object or a Response Object. */
export interface BodyObject {
  content?: Record<string, MediaTypeObject>;
  [key: string]: unknown;
}

export interface OperationObject {
  operationId?: string;
  deprecated?: boolean;
  parameters?: ParameterObject[];
  requestBody?: BodyObject;
  responses?: Record<string, BodyObject>;
  [key: string]: unknown;
}

export interface PathItemObject {
  parameters?: ParameterObject[];
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** OpenAPI 3.1 allows `type: ['string', 'null']`; the order carries no meaning. */
export function typeOf(schema: SchemaObject): string | undefined {
  const { type } = schema;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return [...type].map(String).sort().join('|');
  return undefined;
}

export function propertiesOf(schema: SchemaObject): Record<string, SchemaObject> {
  return isRecord(schema.properties) ? (schema.properties as Record<string, SchemaObject>) : {};
}

export function requiredNamesOf(schema: SchemaObject): Set<string> {
  const { required } = schema;
  return new Set(Array.isArray(required) ? required.filter((n) => typeof n === 'string') : []);
}

export function schemaAt(
  body: BodyObject | undefined,
  mediaType: string,
): SchemaObject | undefined {
  const media = body?.content?.[mediaType];
  return isRecord(media?.schema) ? (media.schema as SchemaObject) : undefined;
}

export function mediaTypesOf(body: BodyObject | undefined): string[] {
  return isRecord(body?.content) ? Object.keys(body.content) : [];
}

export function operationsOf(pathItem: PathItemObject): Map<HttpMethod, OperationObject> {
  const operations = new Map<HttpMethod, OperationObject>();
  for (const method of HTTP_METHODS) {
    const operation = pathItem[method];
    if (isRecord(operation)) operations.set(method, operation as OperationObject);
  }
  return operations;
}

export function pathsOf(spec: OpenApiSpec): Record<string, PathItemObject> {
  return (isRecord(spec.paths) ? spec.paths : {}) as Record<string, PathItemObject>;
}

/**
 * The property named `name` directly on this schema, looking through array hops.
 *
 * `/pets` returns [Pet], so a client addresses Pet's `tag` as `tag` and never
 * `items.tag` — the same elision `DiffTarget.field` makes. `seen` guards the
 * hop chain alone; a cyclic schema is bounded by the caller's finite path.
 */
function propertyAt(
  schema: SchemaObject,
  name: string,
  seen: Set<SchemaObject>,
): SchemaObject | undefined {
  if (seen.has(schema)) return undefined;
  seen.add(schema);

  const direct = propertiesOf(schema)[name];
  if (direct !== undefined) return direct;

  if (isRecord(schema.items)) return propertyAt(schema.items as SchemaObject, name, seen);
  return undefined;
}

/**
 * Can a client address `field` in this schema?
 *
 * Walks the declared path rather than enumerating the schema, which is what
 * makes it total: a self-referencing $ref dereferences into a real object
 * cycle, so `child.child.name` is genuinely addressable and enumeration would
 * never finish producing it. Following a path the caller already wrote is
 * bounded by that path's length.
 */
export function resolvesField(schema: SchemaObject, field: string[]): boolean {
  let current: SchemaObject | undefined = schema;
  for (const segment of field) {
    if (current === undefined) return false;
    current = propertyAt(current, segment, new Set());
  }
  return current !== undefined;
}

/**
 * Field paths in this schema, for suggesting what someone meant.
 *
 * Only ever a hint: the walk stops at a cycle, so a recursive schema lists
 * `child` without the paths beneath it. `resolvesField` decides what is valid,
 * and it does not share this limit.
 */
export function fieldPathsOf(schema: SchemaObject): Set<string> {
  const paths = new Set<string>();
  collectFieldPaths(schema, [], paths, new Set());
  return paths;
}

function collectFieldPaths(
  schema: SchemaObject,
  prefix: string[],
  into: Set<string>,
  ancestors: Set<SchemaObject>,
): void {
  if (ancestors.has(schema)) return;
  ancestors.add(schema);

  try {
    for (const [name, child] of Object.entries(propertiesOf(schema))) {
      const path = [...prefix, name];
      into.add(path.join('.'));
      collectFieldPaths(child, path, into, ancestors);
    }

    if (isRecord(schema.items)) {
      collectFieldPaths(schema.items as SchemaObject, prefix, into, ancestors);
    }
  } finally {
    ancestors.delete(schema);
  }
}
