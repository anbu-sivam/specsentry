import type { DiffKind, DiffTarget } from './types.js';

/**
 * What to do about a change, keyed by kind, as templates over its target.
 *
 * Separate from rules.ts on purpose. `RULES` is constants — the table you scan
 * to retune a severity — and these are functions of a target. Folding them in
 * would triple that table's size and bury severity under sixteen `null`s for
 * the kinds that need no advice.
 *
 * `null` means there is nothing useful to say, and it is spelled out rather
 * than omitted: this is an exhaustive Record, so a new DiffKind has to decide.
 * Only BREAKING kinds carry advice today. Several WARNING kinds could — see
 * CLAUDE.md.
 */
export type Suggest = ((target: DiffTarget | undefined) => string) | null;

/** "GET /pets", or "/pets" for a path-level change, which names no method. */
function endpointName(target: DiffTarget | undefined): string {
  const path = target?.path;
  if (path === undefined) return 'this endpoint';
  return target?.method === undefined ? path : `${target.method.toUpperCase()} ${path}`;
}

/**
 * The changed property, backticked.
 *
 * Falls back when there is no field to name — a parameter's inner schema has
 * none, and a change at the body root has an empty path.
 */
function fieldName(target: DiffTarget | undefined): string {
  const field = target?.field;
  return field === undefined || field.length === 0 ? 'the property' : `\`${field.join('.')}\``;
}

/** Removing surface: the advice is the same whether a path or one method went. */
const restoreAndDeprecate: Suggest = (target) =>
  `Restore ${endpointName(target)} and mark it deprecated, or move the removal to a new API version.`;

export const SUGGESTIONS: Record<DiffKind, Suggest> = {
  'path.added': null,
  'path.removed': restoreAndDeprecate,
  'method.added': null,
  'method.removed': restoreAndDeprecate,

  'param.added.required': () =>
    'Give the new parameter a server-side default and keep it optional; require it only in a new API version.',
  'param.added.optional': null,
  'param.removed': null,
  'param.required.tightened': () =>
    'Keep the parameter optional and default it server-side; require it only in a new API version.',
  'param.required.loosened': null,
  'param.type.changed': () =>
    'Accept both the old and the new type for a deprecation cycle, or take the new type as a separate parameter.',

  'request.property.added.required': (target) =>
    `Add ${fieldName(target)} as optional with a server-side default, and require it once senders have migrated.`,
  'request.property.added.optional': null,
  'request.property.removed': null,
  'request.property.required.tightened': (target) =>
    `Keep ${fieldName(target)} optional and default it server-side; require it only in a new API version.`,
  'request.property.required.loosened': null,
  'request.property.type.changed': (target) =>
    `Accept both the old and the new type for ${fieldName(target)} during a deprecation cycle, or take the new type in a new field.`,
  'request.enum.value.added': null,
  'request.enum.value.removed': (target) =>
    `Keep accepting the dropped value for ${fieldName(target)} and map it to its replacement, or reject it only in a new API version.`,

  'response.property.added': null,
  'response.property.removed': (target) =>
    `Keep returning ${fieldName(target)} for a deprecation cycle, then drop it in a new API version.`,
  'response.property.required.tightened': null,
  'response.property.required.loosened': (target) =>
    `Keep ${fieldName(target)} always present, or check that the consumers named here handle it being absent.`,
  'response.property.type.changed': (target) =>
    `Return the new type in a new field and leave ${fieldName(target)} as it was, or change it in a new API version.`,
  'response.enum.value.added': null,
  'response.enum.value.removed': null,

  'response.status.added': null,
  'response.status.removed': (target) =>
    `Keep documenting the status while ${endpointName(target)} can still return it; consumers may branch on it.`,

  'info.version.changed': null,
  'operation.deprecated': null,
};

/** Undefined when the kind has no advice worth giving. */
export function suggestionFor(kind: DiffKind, target?: DiffTarget): string | undefined {
  const suggest = SUGGESTIONS[kind];
  return suggest === null ? undefined : suggest(target);
}
