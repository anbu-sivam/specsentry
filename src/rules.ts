import type { DiffKind, Severity } from './types.js';

/**
 * Who a change reaches, once consumer manifests say what each service uses.
 *
 * This is per-kind judgement, which is why it lives here as data rather than as
 * branching in impact.ts — same reasoning as severity.
 *
 * `field.omitted` exists because the request side inverts. A consumer breaks on
 * a newly required field precisely *because* their payload omits it, so asking
 * "who declared this field?" finds nobody at the exact moment everybody is
 * affected. Removals and type changes ask the ordinary question.
 */
export type ImpactScope =
  /** Additive or informational: no existing consumer is affected. */
  | 'none'
  /** Anyone calling the endpoint, whatever fields they declared. */
  | 'endpoint'
  /** Consumers that declared the field this change lands on. */
  | 'field.declared'
  /** Consumers calling the endpoint that did *not* declare the field. */
  | 'field.omitted';

export interface Rule {
  severity: Severity;
  /** Shown to the user next to the change. Keep it consumer-facing: describe
   *  what breaks for a client, not what moved in the document. */
  message: string;
  /** Which consumers this kind implicates. See ImpactScope. */
  impact: ImpactScope;
  /** Why this severity. Not printed; for whoever edits this table next. */
  rationale: string;
}

/**
 * The single source of truth for how changes are judged.
 *
 * Editing severities here must not require touching differ.ts or
 * classifier.ts. Every DiffKind needs an entry — the type below is an
 * exhaustive Record, so a missing one is a compile error rather than an
 * unclassified change at runtime.
 */
export const RULES: Record<DiffKind, Rule> = {
  'path.added': {
    severity: 'NON_BREAKING',
    message: 'New path added; existing clients are unaffected.',
    impact: 'none',
    rationale: 'Additive surface. Nobody is calling it yet.',
  },
  'path.removed': {
    severity: 'BREAKING',
    message: 'Path removed; clients calling it will get 404s.',
    impact: 'endpoint',
    rationale: 'Straightforward contract removal.',
  },
  'method.added': {
    severity: 'NON_BREAKING',
    message: 'New method added to an existing path.',
    impact: 'none',
    rationale: 'Additive surface.',
  },
  'method.removed': {
    severity: 'BREAKING',
    message: 'Method removed from an existing path; calls will fail.',
    impact: 'endpoint',
    rationale: 'Straightforward contract removal.',
  },

  'param.added.required': {
    severity: 'BREAKING',
    message: 'New required parameter; existing requests omit it and will be rejected.',
    impact: 'endpoint',
    rationale: 'Old clients cannot know to send it.',
  },
  'param.added.optional': {
    severity: 'NON_BREAKING',
    message: 'New optional parameter; existing requests remain valid.',
    impact: 'none',
    rationale: 'Additive and defaulted.',
  },
  'param.removed': {
    severity: 'WARNING',
    message: 'Parameter removed; clients still sending it may be ignored or rejected.',
    impact: 'endpoint',
    rationale:
      'Depends on server strictness — silently ignored under permissive parsing, 400 under strict. Not knowable from the spec alone.',
  },
  'param.required.tightened': {
    severity: 'BREAKING',
    message: 'Parameter changed from optional to required; requests omitting it will fail.',
    impact: 'endpoint',
    rationale: 'Same reasoning as a new required parameter.',
  },
  'param.required.loosened': {
    severity: 'NON_BREAKING',
    message: 'Parameter changed from required to optional; existing requests remain valid.',
    impact: 'none',
    rationale: 'Relaxing an input constraint accepts a superset of before.',
  },
  'param.type.changed': {
    severity: 'BREAKING',
    message: 'Parameter type changed; existing requests may no longer validate.',
    impact: 'endpoint',
    rationale: 'Assumed breaking. Widening cases (integer -> number) could be refined later.',
  },

  'request.property.added.required': {
    severity: 'BREAKING',
    message: 'New required property in request body; existing payloads will be rejected.',
    impact: 'field.omitted',
    rationale: 'Old clients cannot know to send it.',
  },
  'request.property.added.optional': {
    severity: 'NON_BREAKING',
    message: 'New optional property in request body; existing payloads remain valid.',
    impact: 'none',
    rationale: 'Additive and defaulted.',
  },
  'request.property.removed': {
    severity: 'WARNING',
    message: 'Property removed from request body; clients still sending it may be ignored or rejected.',
    impact: 'field.declared',
    rationale:
      'Same unknowable as param.removed — ignored under permissive parsing, 400 when additionalProperties is false. The spec does not say which.',
  },
  'request.property.required.tightened': {
    severity: 'BREAKING',
    message: 'Request property changed from optional to required; payloads omitting it will fail.',
    impact: 'field.omitted',
    rationale: 'Same reasoning as a new required property.',
  },
  'request.property.required.loosened': {
    severity: 'NON_BREAKING',
    message: 'Request property changed from required to optional; existing payloads remain valid.',
    impact: 'none',
    rationale: 'Relaxing an input constraint accepts a superset of before.',
  },
  'request.property.type.changed': {
    severity: 'BREAKING',
    message: 'Request property type changed; existing payloads may no longer validate.',
    impact: 'field.declared',
    rationale: 'Assumed breaking. Widening cases (integer -> number) could be refined later.',
  },
  'request.enum.value.added': {
    severity: 'NON_BREAKING',
    message: 'New value accepted for a request enum; existing payloads remain valid.',
    impact: 'none',
    rationale: 'The server accepts a superset of what it did before.',
  },
  'request.enum.value.removed': {
    severity: 'BREAKING',
    message: 'Value no longer accepted for a request enum; clients sending it will be rejected.',
    impact: 'field.declared',
    rationale:
      'Narrows the accepted input set. Manifests name fields, not values, so every sender of the field is implicated rather than only those sending the dropped value.',
  },

  'response.property.added': {
    severity: 'NON_BREAKING',
    message: 'New property in response; existing clients ignore fields they do not read.',
    impact: 'none',
    rationale:
      'Additive whether or not the server marks it required — required on a response is a guarantee of presence, and a new guarantee breaks nobody. This is why the response side needs no required/optional split.',
  },
  'response.property.removed': {
    severity: 'BREAKING',
    message: 'Property removed from response; clients reading it will find it missing.',
    impact: 'field.declared',
    rationale: 'Consumers depend on the field being there.',
  },
  'response.property.required.tightened': {
    severity: 'NON_BREAKING',
    message: 'Response property is now always present; clients already handled it appearing.',
    impact: 'none',
    rationale: 'A strengthened guarantee. The mirror of the request side, where tightening breaks.',
  },
  'response.property.required.loosened': {
    severity: 'BREAKING',
    message: 'Response property is no longer guaranteed; clients reading it unconditionally will break.',
    impact: 'field.declared',
    rationale:
      'The server may now omit it. Generated clients turn this into an optional field, which breaks consumers at compile time.',
  },
  'response.property.type.changed': {
    severity: 'BREAKING',
    message: 'Response property type changed; clients will mis-parse this field.',
    impact: 'field.declared',
    rationale: 'Assumed breaking. Widening cases (integer -> number) could be refined later.',
  },
  'response.enum.value.added': {
    severity: 'WARNING',
    message: 'New value returned for a response enum; clients with exhaustive handling may not recognise it.',
    impact: 'field.declared',
    rationale:
      'Safe for clients that pass the value through, breaking for those that switch exhaustively. Not knowable from the spec, so it is flagged rather than judged.',
  },
  'response.enum.value.removed': {
    severity: 'NON_BREAKING',
    message: 'Value no longer returned for a response enum; clients handling it keep working.',
    impact: 'none',
    rationale: 'The server emits a subset of what clients already accept.',
  },

  'response.status.added': {
    severity: 'NON_BREAKING',
    message: 'New response status documented.',
    impact: 'none',
    rationale: 'Additive documentation of behaviour.',
  },
  'response.status.removed': {
    severity: 'BREAKING',
    message: 'Response status removed; clients handling it may break.',
    impact: 'endpoint',
    rationale: 'Consumers may branch on the status.',
  },

  'info.version.changed': {
    severity: 'NON_BREAKING',
    message: 'Spec version changed.',
    impact: 'none',
    rationale: 'Informational; reported so the diff has provenance.',
  },
  'operation.deprecated': {
    severity: 'WARNING',
    message: 'Operation marked deprecated; still works but is scheduled for removal.',
    impact: 'endpoint',
    rationale: 'The canonical warn-then-break signal.',
  },
};

export function ruleFor(kind: DiffKind): Rule {
  return RULES[kind];
}
