import {
  fieldPathsOf,
  isRecord,
  mediaTypesOf,
  operationsOf,
  pathsOf,
  resolvesField,
  schemaAt,
} from './openapi.js';
import type { BodyObject, OperationObject, SchemaObject } from './openapi.js';
import type { ConsumerManifest, ConsumerUsage, OpenApiSpec } from './types.js';

/** One false claim in one manifest. */
export interface ManifestProblem {
  consumer: string;
  /** Absolute path of the file, so the message is actionable. */
  source: string;
  /** Where in the manifest, as a pointer a reader can follow: "uses[1].reads[0]". */
  at: string;
  message: string;
}

export class ManifestValidationError extends Error {
  constructor(readonly problems: ManifestProblem[]) {
    const count = problems.length === 1 ? '1 problem' : `${problems.length} problems`;
    super(`${count} in consumer manifests`);
    this.name = 'ManifestValidationError';
  }
}

/**
 * Every schema a response of this operation can carry.
 *
 * All statuses, not just 2xx: reading a field off a documented 404 body is
 * ordinary, and the manifest does not say which status a field came from.
 */
function responseSchemas(operation: OperationObject): SchemaObject[] {
  const responses = isRecord(operation.responses) ? Object.values(operation.responses) : [];
  return bodySchemas(responses);
}

function requestSchemas(operation: OperationObject): SchemaObject[] {
  return bodySchemas(isRecord(operation.requestBody) ? [operation.requestBody] : []);
}

function bodySchemas(bodies: BodyObject[]): SchemaObject[] {
  return bodies.flatMap((body) =>
    mediaTypesOf(body)
      .map((mediaType) => schemaAt(body, mediaType))
      .filter((schema): schema is SchemaObject => schema !== undefined),
  );
}

function addressable(schemas: SchemaObject[], field: string): boolean {
  const segments = field.split('.');
  return schemas.some((schema) => resolvesField(schema, segments));
}

/** Enough of the real field names to fix a typo, without pasting a whole schema. */
function listAvailable(schemas: SchemaObject[]): string {
  const fields = new Set<string>();
  for (const schema of schemas) {
    for (const field of fieldPathsOf(schema)) fields.add(field);
  }

  const shown = [...fields].sort();
  const capped = shown.slice(0, 8);
  return ` (available: ${capped.join(', ')}${shown.length > capped.length ? ', …' : ''})`;
}

function checkUsage(
  usage: ConsumerUsage,
  at: string,
  manifest: ConsumerManifest,
  spec: OpenApiSpec,
): ManifestProblem[] {
  const problem = (suffix: string, message: string): ManifestProblem => ({
    consumer: manifest.consumer,
    source: manifest.source,
    at: `${at}${suffix}`,
    message,
  });

  const pathItem = pathsOf(spec)[usage.path];
  if (!isRecord(pathItem)) {
    return [problem('.path', `"${usage.path}" is not a path in the spec`)];
  }

  const operations = operationsOf(pathItem);
  const operation = operations.get(usage.method);
  if (operation === undefined) {
    const defined = [...operations.keys()].sort();
    const has = defined.length === 0 ? 'it defines no methods' : `it has: ${defined.join(', ')}`;
    return [problem('.method', `"${usage.method}" is not defined on "${usage.path}" — ${has}`)];
  }

  // A bad path or method makes every field under it meaningless, so those
  // return early: reporting each field as unknown too would bury the one
  // problem that needs fixing. Separate `uses` entries are still all reported.
  const where = `${usage.method} ${usage.path}`;
  const problems: ManifestProblem[] = [];

  const readable = responseSchemas(operation);
  usage.reads.forEach((field, index) => {
    if (addressable(readable, field)) return;
    problems.push(
      problem(
        `.reads[${index}]`,
        readable.length === 0
          ? `"${field}" cannot be read: ${where} documents no response body`
          : `"${field}" is not in any response of ${where}${listAvailable(readable)}`,
      ),
    );
  });

  const sendable = requestSchemas(operation);
  usage.sends.forEach((field, index) => {
    if (addressable(sendable, field)) return;
    problems.push(
      problem(
        `.sends[${index}]`,
        sendable.length === 0
          ? `"${field}" cannot be sent: ${where} takes no request body`
          : `"${field}" is not in the request body of ${where}${listAvailable(sendable)}`,
      ),
    );
  });

  return problems;
}

/**
 * Check every claim each manifest makes against the spec it describes.
 *
 * Validated against the **old** spec, because that is the contract the
 * consumers are running against today: a field that only exists in the new spec
 * is one nobody can be using yet, and a manifest declaring it is describing a
 * future it has not shipped.
 *
 * Returns every problem rather than throwing at the first, since one stale
 * manifest usually has several stale lines and fixing them one run at a time is
 * miserable.
 */
export function validateManifests(
  manifests: ConsumerManifest[],
  spec: OpenApiSpec,
): ManifestProblem[] {
  return manifests.flatMap((manifest) =>
    manifest.uses.flatMap((usage, index) => checkUsage(usage, `uses[${index}]`, manifest, spec)),
  );
}
