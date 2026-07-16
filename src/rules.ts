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
    rationale:
      'Assumed breaking regardless of direction. Widening cases (integer -> number) could be refined later.',
  },

  'schema.property.added.required': {
    severity: 'BREAKING',
    message: 'New required property in request body; existing payloads will be rejected.',
    rationale:
      'Breaking on the request side. If the differ later distinguishes response schemas, that direction is additive and needs its own kind.',
  },
  'schema.property.added.optional': {
    severity: 'NON_BREAKING',
    message: 'New optional property; existing payloads remain valid.',
    rationale: 'Additive and defaulted.',
  },
  'schema.property.removed': {
    severity: 'BREAKING',
    message: 'Property removed; clients reading it will find it missing.',
    rationale: 'Breaking on the response side, where consumers depend on the field.',
  },
  'schema.type.changed': {
    severity: 'BREAKING',
    message: 'Property type changed; clients will mis-parse this field.',
    rationale: 'Assumed breaking in either direction.',
  },
  'schema.enum.value.added': {
    severity: 'WARNING',
    message: 'New enum value; clients with exhaustive handling may not recognise it.',
    rationale:
      'Additive for requests, potentially breaking for responses if clients switch exhaustively. Flagged rather than judged.',
  },
  'schema.enum.value.removed': {
    severity: 'BREAKING',
    message: 'Enum value removed; requests sending it will be rejected.',
    rationale: 'Narrows the accepted input set.',
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
