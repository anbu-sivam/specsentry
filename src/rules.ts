import type { DiffKind, Severity } from './types.js';

export interface Rule {
  severity: Severity;
  /** Shown to the user next to the change. Keep it consumer-facing: describe
   *  what breaks for a client, not what moved in the document. */
  message: string;
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
    rationale: 'Additive surface. Nobody is calling it yet.',
  },
  'path.removed': {
    severity: 'BREAKING',
    message: 'Path removed; clients calling it will get 404s.',
    rationale: 'Straightforward contract removal.',
  },
  'method.added': {
    severity: 'NON_BREAKING',
    message: 'New method added to an existing path.',
    rationale: 'Additive surface.',
  },
  'method.removed': {
    severity: 'BREAKING',
    message: 'Method removed from an existing path; calls will fail.',
    rationale: 'Straightforward contract removal.',
  },

  'param.added.required': {
    severity: 'BREAKING',
    message: 'New required parameter; existing requests omit it and will be rejected.',
    rationale: 'Old clients cannot know to send it.',
  },
  'param.added.optional': {
    severity: 'NON_BREAKING',
    message: 'New optional parameter; existing requests remain valid.',
    rationale: 'Additive and defaulted.',
  },
  'param.removed': {
    severity: 'WARNING',
    message: 'Parameter removed; clients still sending it may be ignored or rejected.',
    rationale:
      'Depends on server strictness — silently ignored under permissive parsing, 400 under strict. Not knowable from the spec alone.',
  },
  'param.required.tightened': {
    severity: 'BREAKING',
    message: 'Parameter changed from optional to required; requests omitting it will fail.',
    rationale: 'Same reasoning as a new required parameter.',
  },
  'param.required.loosened': {
    severity: 'NON_BREAKING',
    message: 'Parameter changed from required to optional; existing requests remain valid.',
    rationale: 'Relaxing an input constraint accepts a superset of before.',
  },
  'param.type.changed': {
    severity: 'BREAKING',
    message: 'Parameter type changed; existing requests may no longer validate.',
    rationale: 'Assumed breaking. Widening cases (integer -> number) could be refined later.',
  },

  'request.property.added.required': {
    severity: 'BREAKING',
    message: 'New required property in request body; existing payloads will be rejected.',
    rationale: 'Old clients cannot know to send it.',
  },
  'request.property.added.optional': {
    severity: 'NON_BREAKING',
    message: 'New optional property in request body; existing payloads remain valid.',
    rationale: 'Additive and defaulted.',
  },
  'request.property.removed': {
    severity: 'WARNING',
    message: 'Property removed from request body; clients still sending it may be ignored or rejected.',
    rationale:
      'Same unknowable as param.removed — ignored under permissive parsing, 400 when additionalProperties is false. The spec does not say which.',
  },
  'request.property.required.tightened': {
    severity: 'BREAKING',
    message: 'Request property changed from optional to required; payloads omitting it will fail.',
    rationale: 'Same reasoning as a new required property.',
  },
  'request.property.required.loosened': {
    severity: 'NON_BREAKING',
    message: 'Request property changed from required to optional; existing payloads remain valid.',
    rationale: 'Relaxing an input constraint accepts a superset of before.',
  },
  'request.property.type.changed': {
    severity: 'BREAKING',
    message: 'Request property type changed; existing payloads may no longer validate.',
    rationale: 'Assumed breaking. Widening cases (integer -> number) could be refined later.',
  },
  'request.enum.value.added': {
    severity: 'NON_BREAKING',
    message: 'New value accepted for a request enum; existing payloads remain valid.',
    rationale: 'The server accepts a superset of what it did before.',
  },
  'request.enum.value.removed': {
    severity: 'BREAKING',
    message: 'Value no longer accepted for a request enum; clients sending it will be rejected.',
    rationale: 'Narrows the accepted input set.',
  },

  'response.property.added': {
    severity: 'NON_BREAKING',
    message: 'New property in response; existing clients ignore fields they do not read.',
    rationale:
      'Additive whether or not the server marks it required — required on a response is a guarantee of presence, and a new guarantee breaks nobody. This is why the response side needs no required/optional split.',
  },
  'response.property.removed': {
    severity: 'BREAKING',
    message: 'Property removed from response; clients reading it will find it missing.',
    rationale: 'Consumers depend on the field being there.',
  },
  'response.property.required.tightened': {
    severity: 'NON_BREAKING',
    message: 'Response property is now always present; clients already handled it appearing.',
    rationale: 'A strengthened guarantee. The mirror of the request side, where tightening breaks.',
  },
  'response.property.required.loosened': {
    severity: 'BREAKING',
    message: 'Response property is no longer guaranteed; clients reading it unconditionally will break.',
    rationale:
      'The server may now omit it. Generated clients turn this into an optional field, which breaks consumers at compile time.',
  },
  'response.property.type.changed': {
    severity: 'BREAKING',
    message: 'Response property type changed; clients will mis-parse this field.',
    rationale: 'Assumed breaking. Widening cases (integer -> number) could be refined later.',
  },
  'response.enum.value.added': {
    severity: 'WARNING',
    message: 'New value returned for a response enum; clients with exhaustive handling may not recognise it.',
    rationale:
      'Safe for clients that pass the value through, breaking for those that switch exhaustively. Not knowable from the spec, so it is flagged rather than judged.',
  },
  'response.enum.value.removed': {
    severity: 'NON_BREAKING',
    message: 'Value no longer returned for a response enum; clients handling it keep working.',
    rationale: 'The server emits a subset of what clients already accept.',
  },

  'response.status.added': {
    severity: 'NON_BREAKING',
    message: 'New response status documented.',
    rationale: 'Additive documentation of behaviour.',
  },
  'response.status.removed': {
    severity: 'BREAKING',
    message: 'Response status removed; clients handling it may break.',
    rationale: 'Consumers may branch on the status.',
  },

  'info.version.changed': {
    severity: 'NON_BREAKING',
    message: 'Spec version changed.',
    rationale: 'Informational; reported so the diff has provenance.',
  },
  'operation.deprecated': {
    severity: 'WARNING',
    message: 'Operation marked deprecated; still works but is scheduled for removal.',
    rationale: 'The canonical warn-then-break signal.',
  },
};

export function ruleFor(kind: DiffKind): Rule {
  return RULES[kind];
}
