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
  // parameters — always request-side, so they need no direction suffix
  | 'param.added.required'
  | 'param.added.optional'
  | 'param.removed'
  | 'param.required.tightened'
  | 'param.required.loosened'
  | 'param.type.changed'
  // request body schemas — the client writes these, the server validates them
  | 'request.property.added.required'
  | 'request.property.added.optional'
  | 'request.property.removed'
  | 'request.property.required.tightened'
  | 'request.property.required.loosened'
  | 'request.property.type.changed'
  | 'request.enum.value.added'
  | 'request.enum.value.removed'
  // response schemas — the server writes these, the client reads them
  | 'response.property.added'
  | 'response.property.removed'
  | 'response.property.required.tightened'
  | 'response.property.required.loosened'
  | 'response.property.type.changed'
  | 'response.enum.value.added'
  | 'response.enum.value.removed'
  // response surface
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
  /** e.g. "paths./users/{id}.get.parameters.query.limit" */
  location: DiffLocation;
  /**
   * The old and new values, when the change has them. These are deliberately
   * scalars or small literals rather than the spec nodes themselves: a
   * dereferenced schema can be cyclic, and the CLI serialises this report with
   * JSON.stringify.
   */
  before?: unknown;
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
