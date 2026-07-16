/**
 * Shared vocabulary for the whole pipeline:
 *   loader -> differ -> classifier -> cli
 */

/** Operation keys of a Path Item Object, per OpenAPI 3.x. */
export const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Which side of the wire something sits on: clients send requests, read responses. */
export type Direction = 'request' | 'response';

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

/**
 * The same place as `location`, in parts rather than flattened.
 *
 * `location` is for humans and cannot be reliably parsed back: `properties` and
 * `items` are legal property names, and a path may contain dots, so the string
 * is ambiguous about which segment is what. Anything that needs to reason about
 * where a change landed — the consumer cross-reference does — reads this
 * instead of taking the string apart.
 */
export interface DiffTarget {
  /** Templated exactly as the spec writes it: "/pets/{petId}". */
  path?: string;
  method?: HttpMethod;
  /**
   * The parameter a change lands on or inside, for `param.*` kinds and for
   * anything found within a parameter's own schema.
   *
   * Separate from `field` because a parameter is addressed by name, not by a
   * path into a body — and `field` is what impact.ts matches against a
   * manifest's `reads`/`sends`, which only ever name body fields.
   */
  parameter?: string;
  direction?: Direction;
  /**
   * Property names from the payload root down to what changed, as a client
   * would address them in JSON: array hops are elided, because `items` is how
   * the document nests and not part of any field name. Absent inside parameter
   * schemas, which have no body field to name.
   */
  field?: string[];
}

/** A single structural difference, before any judgement is applied. */
export interface RawDifference {
  kind: DiffKind;
  /** e.g. "paths./users/{id}.get.parameters.query.limit" */
  location: DiffLocation;
  /** Absent only for changes that belong to no endpoint, e.g. info.version. */
  target?: DiffTarget;
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
  /** How to fix or soften the break, from src/suggestions.ts. Absent when the kind has no advice. */
  suggestion?: string;
}

/** What one consumer service declares it uses of one endpoint. */
export interface ConsumerUsage {
  path: string;
  method: HttpMethod;
  /** Response fields this consumer reads, dotted for nesting: "owner.name". */
  reads: string[];
  /** Request body fields this consumer sends. */
  sends: string[];
}

export interface ConsumerManifest {
  /** Service name, as reported. Unique across a loaded set. */
  consumer: string;
  /** Absolute path the manifest was read from. */
  source: string;
  uses: ConsumerUsage[];
}

/** A classified difference plus the consumers that declared use of what moved. */
export interface ImpactedDifference extends ClassifiedDifference {
  /** Sorted, and empty when no loaded manifest is affected. */
  consumers: string[];
}

export interface DriftReport {
  oldSource: string;
  newSource: string;
  /**
   * Every consumer whose manifest was loaded, affected or not. Absent when no
   * manifest directory was given, which is what separates "nobody uses this"
   * from "nobody told us who uses this".
   */
  knownConsumers?: string[];
  differences: ImpactedDifference[];
  summary: Record<Severity, number>;
}
