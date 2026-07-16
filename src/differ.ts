import type { DiffKind, LoadedSpec, RawDifference } from './types.js';

/** Operation keys of a Path Item Object, per OpenAPI 3.x. */
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/**
 * Which side of the wire a schema sits on.
 *
 * This is the axis the schema kinds are split along. A client writes requests
 * and reads responses, so one structural edit lands on opposite parties
 * depending on where it happens: adding a required field breaks senders,
 * removing a field breaks readers. The walker carries the direction so it can
 * name which side moved; rules.ts alone decides what that costs.
 */
type Direction = 'request' | 'response';

interface SchemaObject {
  type?: string | string[];
  properties?: Record<string, SchemaObject>;
  required?: string[];
  items?: SchemaObject;
  enum?: unknown[];
  [key: string]: unknown;
}

interface ParameterObject {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: SchemaObject;
  [key: string]: unknown;
}

interface MediaTypeObject {
  schema?: SchemaObject;
  [key: string]: unknown;
}

interface OperationObject {
  operationId?: string;
  deprecated?: boolean;
  parameters?: ParameterObject[];
  requestBody?: { content?: Record<string, MediaTypeObject>; [key: string]: unknown };
  responses?: Record<string, { content?: Record<string, MediaTypeObject>; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface PathItemObject {
  parameters?: ParameterObject[];
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** OpenAPI 3.1 allows `type: ['string', 'null']`; the order carries no meaning. */
function typeOf(schema: SchemaObject): string | undefined {
  const { type } = schema;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return [...type].map(String).sort().join('|');
  return undefined;
}

function propertiesOf(schema: SchemaObject): Record<string, SchemaObject> {
  return isRecord(schema.properties) ? (schema.properties as Record<string, SchemaObject>) : {};
}

function requiredNamesOf(schema: SchemaObject): Set<string> {
  const { required } = schema;
  return new Set(Array.isArray(required) ? required.filter((n) => typeof n === 'string') : []);
}

/** Anything with a `content` map: a Request Body Object or a Response Object. */
interface BodyObject {
  content?: Record<string, MediaTypeObject>;
}

function schemaAt(body: BodyObject | undefined, mediaType: string): SchemaObject | undefined {
  const media = body?.content?.[mediaType];
  return isRecord(media?.schema) ? (media.schema as SchemaObject) : undefined;
}

function mediaTypesOf(body: BodyObject | undefined): string[] {
  return isRecord(body?.content) ? Object.keys(body.content) : [];
}

/**
 * Adding a property to a response is additive whether or not it is required,
 * so the response side collapses to one kind while the request side keeps the
 * required/optional distinction that decides whether old payloads still pass.
 */
function propertyAddedKind(direction: Direction, requiredInNew: boolean): DiffKind {
  if (direction === 'response') return 'response.property.added';
  return requiredInNew ? 'request.property.added.required' : 'request.property.added.optional';
}

/**
 * Compare one schema node against its counterpart and recurse.
 *
 * `ancestors` holds the old-side nodes currently open on the stack. Dereferencing
 * turns a self-referencing $ref into a genuine object cycle, so a schema that
 * contains itself would otherwise recurse forever. Tracking only the open path
 * (rather than everything seen) means a schema reused in sibling subtrees is
 * still compared in each of them — only a true cycle stops the walk.
 *
 * `rootTypeKind` lets a caller name the type change at this node in its own
 * vocabulary. Parameters use it so that a query param changing from string to
 * integer reads as `param.type.changed` rather than a generic property change;
 * it deliberately does not propagate into the recursion below.
 */
function compareSchema(
  before: SchemaObject,
  after: SchemaObject,
  location: string,
  direction: Direction,
  ancestors: Set<SchemaObject>,
  rootTypeKind?: DiffKind,
): RawDifference[] {
  if (ancestors.has(before)) return [];
  ancestors.add(before);

  try {
    const differences: RawDifference[] = [];

    const beforeType = typeOf(before);
    const afterType = typeOf(after);
    if (beforeType !== afterType) {
      differences.push({
        kind: rootTypeKind ?? `${direction}.property.type.changed`,
        location,
        before: beforeType,
        after: afterType,
      });
    }

    differences.push(...compareEnumValues(before, after, location, direction));
    differences.push(...compareProperties(before, after, location, direction, ancestors));

    if (isRecord(before.items) && isRecord(after.items)) {
      differences.push(
        ...compareSchema(
          before.items as SchemaObject,
          after.items as SchemaObject,
          `${location}.items`,
          direction,
          ancestors,
        ),
      );
    }

    return differences;
  } finally {
    ancestors.delete(before);
  }
}

/**
 * Only compared when both sides constrain the value. Going from no enum to an
 * enum narrows the accepted set rather than adding values to an existing one,
 * which is a different change than any kind here names.
 */
function compareEnumValues(
  before: SchemaObject,
  after: SchemaObject,
  location: string,
  direction: Direction,
): RawDifference[] {
  if (!Array.isArray(before.enum) || !Array.isArray(after.enum)) return [];

  const identity = (value: unknown) => JSON.stringify(value);
  const beforeValues = new Map(before.enum.map((v) => [identity(v), v]));
  const afterValues = new Map(after.enum.map((v) => [identity(v), v]));
  const differences: RawDifference[] = [];

  for (const [key, value] of beforeValues) {
    if (!afterValues.has(key)) {
      differences.push({ kind: `${direction}.enum.value.removed`, location, before: value });
    }
  }
  for (const [key, value] of afterValues) {
    if (!beforeValues.has(key)) {
      differences.push({ kind: `${direction}.enum.value.added`, location, after: value });
    }
  }

  return differences;
}

function compareProperties(
  before: SchemaObject,
  after: SchemaObject,
  location: string,
  direction: Direction,
  ancestors: Set<SchemaObject>,
): RawDifference[] {
  const beforeProps = propertiesOf(before);
  const afterProps = propertiesOf(after);
  const beforeRequired = requiredNamesOf(before);
  const afterRequired = requiredNamesOf(after);
  const differences: RawDifference[] = [];

  for (const [name, schema] of Object.entries(beforeProps)) {
    if (name in afterProps) continue;
    differences.push({
      kind: `${direction}.property.removed`,
      location: `${location}.properties.${name}`,
      before: typeOf(schema),
    });
  }

  for (const [name, schema] of Object.entries(afterProps)) {
    if (name in beforeProps) continue;
    differences.push({
      kind: propertyAddedKind(direction, afterRequired.has(name)),
      location: `${location}.properties.${name}`,
      after: typeOf(schema),
    });
  }

  for (const [name, beforeSchema] of Object.entries(beforeProps)) {
    const afterSchema = afterProps[name];
    if (afterSchema === undefined) continue;

    const propertyLocation = `${location}.properties.${name}`;
    const wasRequired = beforeRequired.has(name);
    const isRequired = afterRequired.has(name);
    if (wasRequired !== isRequired) {
      differences.push({
        kind: isRequired
          ? `${direction}.property.required.tightened`
          : `${direction}.property.required.loosened`,
        location: propertyLocation,
        before: wasRequired,
        after: isRequired,
      });
    }

    differences.push(
      ...compareSchema(beforeSchema, afterSchema, propertyLocation, direction, ancestors),
    );
  }

  return differences;
}

/** A parameter is identified by name and location, not by name alone. */
function parameterKey(parameter: ParameterObject): string {
  return `${parameter.in ?? 'query'}:${parameter.name ?? ''}`;
}

/**
 * Path-level parameters apply to every operation under that path unless the
 * operation redefines the same name/in pair. Merging them means the diff sees
 * what a caller actually has to send, not how the document happened to spread
 * it across two lists.
 */
function effectiveParameters(
  pathItem: PathItemObject,
  operation: OperationObject,
): Map<string, ParameterObject> {
  const merged = new Map<string, ParameterObject>();
  for (const list of [pathItem.parameters, operation.parameters]) {
    if (!Array.isArray(list)) continue;
    for (const parameter of list) {
      if (isRecord(parameter)) merged.set(parameterKey(parameter), parameter);
    }
  }
  return merged;
}

function describeParameter(parameter: ParameterObject): Record<string, unknown> {
  return {
    name: parameter.name,
    in: parameter.in,
    required: parameter.required === true,
    type: isRecord(parameter.schema) ? typeOf(parameter.schema as SchemaObject) : undefined,
  };
}

function parameterLocation(operationLocation: string, parameter: ParameterObject): string {
  return `${operationLocation}.parameters.${parameter.in ?? 'query'}.${parameter.name ?? ''}`;
}

function compareParameters(
  beforePathItem: PathItemObject,
  afterPathItem: PathItemObject,
  beforeOperation: OperationObject,
  afterOperation: OperationObject,
  operationLocation: string,
): RawDifference[] {
  const before = effectiveParameters(beforePathItem, beforeOperation);
  const after = effectiveParameters(afterPathItem, afterOperation);
  const differences: RawDifference[] = [];

  for (const [key, parameter] of before) {
    if (after.has(key)) continue;
    differences.push({
      kind: 'param.removed',
      location: parameterLocation(operationLocation, parameter),
      before: describeParameter(parameter),
    });
  }

  for (const [key, parameter] of after) {
    if (before.has(key)) continue;
    differences.push({
      kind: parameter.required === true ? 'param.added.required' : 'param.added.optional',
      location: parameterLocation(operationLocation, parameter),
      after: describeParameter(parameter),
    });
  }

  for (const [key, beforeParameter] of before) {
    const afterParameter = after.get(key);
    if (afterParameter === undefined) continue;

    const location = parameterLocation(operationLocation, afterParameter);
    const wasRequired = beforeParameter.required === true;
    const isRequired = afterParameter.required === true;
    if (wasRequired !== isRequired) {
      differences.push({
        kind: isRequired ? 'param.required.tightened' : 'param.required.loosened',
        location,
        before: wasRequired,
        after: isRequired,
      });
    }

    const beforeSchema = beforeParameter.schema;
    const afterSchema = afterParameter.schema;
    if (isRecord(beforeSchema) && isRecord(afterSchema)) {
      differences.push(
        ...compareSchema(
          beforeSchema as SchemaObject,
          afterSchema as SchemaObject,
          location,
          'request',
          new Set(),
          'param.type.changed',
        ),
      );
    }
  }

  return differences;
}

function compareRequestBody(
  beforeOperation: OperationObject,
  afterOperation: OperationObject,
  operationLocation: string,
): RawDifference[] {
  const before = beforeOperation.requestBody;
  const after = afterOperation.requestBody;
  if (!isRecord(before) || !isRecord(after)) return [];

  const differences: RawDifference[] = [];
  for (const mediaType of mediaTypesOf(before)) {
    const beforeSchema = schemaAt(before, mediaType);
    const afterSchema = schemaAt(after, mediaType);
    if (beforeSchema === undefined || afterSchema === undefined) continue;

    differences.push(
      ...compareSchema(
        beforeSchema,
        afterSchema,
        `${operationLocation}.requestBody.content.${mediaType}.schema`,
        'request',
        new Set(),
      ),
    );
  }
  return differences;
}

function compareResponses(
  beforeOperation: OperationObject,
  afterOperation: OperationObject,
  operationLocation: string,
): RawDifference[] {
  const before = isRecord(beforeOperation.responses) ? beforeOperation.responses : {};
  const after = isRecord(afterOperation.responses) ? afterOperation.responses : {};
  const differences: RawDifference[] = [];

  for (const status of Object.keys(before)) {
    if (status in after) continue;
    differences.push({
      kind: 'response.status.removed',
      location: `${operationLocation}.responses.${status}`,
      before: status,
    });
  }

  for (const status of Object.keys(after)) {
    if (status in before) continue;
    differences.push({
      kind: 'response.status.added',
      location: `${operationLocation}.responses.${status}`,
      after: status,
    });
  }

  for (const status of Object.keys(before)) {
    const beforeResponse = before[status];
    const afterResponse = after[status];
    if (!isRecord(beforeResponse) || !isRecord(afterResponse)) continue;

    for (const mediaType of mediaTypesOf(beforeResponse)) {
      const beforeSchema = schemaAt(beforeResponse, mediaType);
      const afterSchema = schemaAt(afterResponse, mediaType);
      if (beforeSchema === undefined || afterSchema === undefined) continue;

      differences.push(
        ...compareSchema(
          beforeSchema,
          afterSchema,
          `${operationLocation}.responses.${status}.content.${mediaType}.schema`,
          'response',
          new Set(),
        ),
      );
    }
  }

  return differences;
}

function compareOperation(
  beforePathItem: PathItemObject,
  afterPathItem: PathItemObject,
  beforeOperation: OperationObject,
  afterOperation: OperationObject,
  operationLocation: string,
): RawDifference[] {
  const differences: RawDifference[] = [];

  if (beforeOperation.deprecated !== true && afterOperation.deprecated === true) {
    differences.push({
      kind: 'operation.deprecated',
      location: operationLocation,
      before: false,
      after: true,
    });
  }

  differences.push(
    ...compareParameters(
      beforePathItem,
      afterPathItem,
      beforeOperation,
      afterOperation,
      operationLocation,
    ),
    ...compareRequestBody(beforeOperation, afterOperation, operationLocation),
    ...compareResponses(beforeOperation, afterOperation, operationLocation),
  );

  return differences;
}

function operationsOf(pathItem: PathItemObject): Map<string, OperationObject> {
  const operations = new Map<string, OperationObject>();
  for (const method of HTTP_METHODS) {
    const operation = pathItem[method];
    if (isRecord(operation)) operations.set(method, operation as OperationObject);
  }
  return operations;
}

function methodNamesOf(pathItem: PathItemObject): string[] {
  return [...operationsOf(pathItem).keys()];
}

/**
 * An added or removed path or method is reported once, without walking inside
 * it. Every parameter and status code it carries went with it, and listing them
 * all would bury the one finding that matters under its own consequences.
 */
function comparePaths(
  beforePaths: Record<string, PathItemObject>,
  afterPaths: Record<string, PathItemObject>,
): RawDifference[] {
  const differences: RawDifference[] = [];

  for (const path of Object.keys(beforePaths)) {
    if (path in afterPaths) continue;
    differences.push({
      kind: 'path.removed',
      location: `paths.${path}`,
      before: { methods: methodNamesOf(beforePaths[path] as PathItemObject) },
    });
  }

  for (const path of Object.keys(afterPaths)) {
    if (path in beforePaths) continue;
    differences.push({
      kind: 'path.added',
      location: `paths.${path}`,
      after: { methods: methodNamesOf(afterPaths[path] as PathItemObject) },
    });
  }

  for (const path of Object.keys(beforePaths)) {
    const beforePathItem = beforePaths[path];
    const afterPathItem = afterPaths[path];
    if (!isRecord(beforePathItem) || !isRecord(afterPathItem)) continue;

    const beforeOperations = operationsOf(beforePathItem);
    const afterOperations = operationsOf(afterPathItem);

    for (const [method, operation] of beforeOperations) {
      if (afterOperations.has(method)) continue;
      differences.push({
        kind: 'method.removed',
        location: `paths.${path}.${method}`,
        before: { operationId: operation.operationId },
      });
    }

    for (const [method, operation] of afterOperations) {
      if (beforeOperations.has(method)) continue;
      differences.push({
        kind: 'method.added',
        location: `paths.${path}.${method}`,
        after: { operationId: operation.operationId },
      });
    }

    for (const [method, beforeOperation] of beforeOperations) {
      const afterOperation = afterOperations.get(method);
      if (afterOperation === undefined) continue;
      differences.push(
        ...compareOperation(
          beforePathItem,
          afterPathItem,
          beforeOperation,
          afterOperation,
          `paths.${path}.${method}`,
        ),
      );
    }
  }

  return differences;
}

/**
 * Walk two dereferenced specs and report every structural difference.
 *
 * Judgement-free by design: this names what changed and where, and leaves every
 * severity call to the rules table. Only paths reachable from `paths` are
 * walked — an unused entry under `components.schemas` is part of no endpoint's
 * contract, and a used one is already inlined at each use site by the loader.
 */
export function diffSpecs(oldSpec: LoadedSpec, newSpec: LoadedSpec): RawDifference[] {
  const before = oldSpec.spec;
  const after = newSpec.spec;
  const differences: RawDifference[] = [];

  if (before.info?.version !== after.info?.version) {
    differences.push({
      kind: 'info.version.changed',
      location: 'info.version',
      before: before.info?.version,
      after: after.info?.version,
    });
  }

  differences.push(
    ...comparePaths(
      (isRecord(before.paths) ? before.paths : {}) as Record<string, PathItemObject>,
      (isRecord(after.paths) ? after.paths : {}) as Record<string, PathItemObject>,
    ),
  );

  return differences;
}
