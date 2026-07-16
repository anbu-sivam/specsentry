/**
 * Shared vocabulary for the whole pipeline:
 *   loader -> differ -> classifier -> cli
 */

/** A dereferenced OpenAPI 3.x document. Loosely typed for now. */
export interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string; [k: string]: unknown };
  paths?: Record<string, unknown>;
  components?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface LoadedSpec {
  /** Absolute path the spec was read from. */
  source: string;
  /** Fully dereferenced document ($refs resolved in place). */
  spec: OpenApiSpec;
}

/**
 * The kind of structural change the differ found. Every kind must have a
 * matching entry in the rules table (src/rules.ts) — the classifier looks
 * changes up by this key, so adding a kind here means adding a rule there.
 */
export type DiffKind =
  // endpoint surface
  | 'path.added'
  | 'path.removed'
  | 'method.added'
  | 'method.removed'
  // parameters
  | 'param.added.required'
  | 'param.added.optional'
  | 'param.removed'
  | 'param.required.tightened'
  | 'param.required.loosened'
  | 'param.type.changed'
  // request / response schemas
  | 'schema.property.added.required'
  | 'schema.property.added.optional'
  | 'schema.property.removed'
  | 'schema.type.changed'
  | 'schema.enum.value.added'
  | 'schema.enum.value.removed'
  // responses
  | 'response.status.added'
  | 'response.status.removed'
  // metadata
  | 'info.version.changed'
  | 'operation.deprecated';

/** Where in the spec a change occurred, as a JSON-pointer-ish path. */
export type DiffLocation = string;

/** A single structural difference, before any judgement is applied. */
export interface RawDifference {
  kind: DiffKind;
  /** e.g. "paths./users/{id}.get.parameters.limit" */
  location: DiffLocation;
  /** Value in the old spec, if the change has one. */
  before?: unknown;
  /** Value in the new spec, if the change has one. */
  after?: unknown;
}

export type Severity = 'BREAKING' | 'NON_BREAKING' | 'WARNING';

/** A raw difference plus the verdict the rules table assigned to it. */
export interface ClassifiedDifference extends RawDifference {
  severity: Severity;
  /** Human-readable explanation, sourced from the rule. */
  message: string;
}

export interface DriftReport {
  oldSource: string;
  newSource: string;
  differences: ClassifiedDifference[];
  summary: Record<Severity, number>;
}
