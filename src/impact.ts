import { ruleFor } from './rules.js';
import type { ImpactScope } from './rules.js';
import type {
  ClassifiedDifference,
  ConsumerManifest,
  ConsumerUsage,
  DiffTarget,
  Direction,
  ImpactedDifference,
} from './types.js';

/** A consumer sends request fields and reads response ones — never the reverse. */
function declaredFields(usage: ConsumerUsage, direction: Direction): string[] {
  return direction === 'request' ? usage.sends : usage.reads;
}

/**
 * Segment-wise prefix, either way round. A consumer that declared `owner`
 * depends on everything beneath it, and one that declared `owner.name` loses it
 * when `owner` itself goes. Comparing segments rather than strings keeps `own`
 * from matching `owner`.
 */
function overlaps(declared: string[], changed: string[]): boolean {
  const [shorter, longer] =
    declared.length <= changed.length ? [declared, changed] : [changed, declared];
  return shorter.every((segment, index) => segment === longer[index]);
}

function callsEndpoint(usage: ConsumerUsage, target: DiffTarget): boolean {
  if (usage.path !== target.path) return false;
  // A path-level change names no method because it takes every method with it.
  return target.method === undefined || usage.method === target.method;
}

function isAffected(
  manifest: ConsumerManifest,
  target: DiffTarget,
  scope: Exclude<ImpactScope, 'none'>,
): boolean {
  const uses = manifest.uses.filter((usage) => callsEndpoint(usage, target));
  if (uses.length === 0) return false;
  if (scope === 'endpoint') return true;

  const { direction, field } = target;
  // A field-scoped change with no field to name sits inside a parameter's
  // schema, which no manifest can address. Attribute it to the endpoint rather
  // than report a breaking change as hitting nobody.
  if (direction === undefined || field === undefined) return true;

  const declared = uses.flatMap((usage) => declaredFields(usage, direction));
  if (scope === 'field.declared') {
    return declared.some((name) => overlaps(name.split('.'), field));
  }

  // field.omitted asks whether the payload definitely carries this exact field,
  // so a declared ancestor cannot stand in for it: an object declared before
  // this leaf became required is precisely what would be missing it.
  return !declared.includes(field.join('.'));
}

function consumersFor(difference: ClassifiedDifference, manifests: ConsumerManifest[]): string[] {
  const scope = ruleFor(difference.kind).impact;
  if (scope === 'none') return [];

  const { target } = difference;
  if (target?.path === undefined) return [];

  return manifests
    .filter((manifest) => isAffected(manifest, target, scope))
    .map((manifest) => manifest.consumer)
    .sort();
}

/**
 * Name the consumers each difference reaches.
 *
 * Which consumers a change implicates is per-kind judgement, so it is read from
 * the rules table as `impact` rather than decided here. Keep this module free
 * of `if (kind === ...)` for the same reason classifier.ts is: a rule that the
 * table cannot express is a sign the differ should say more about its target.
 */
export function attributeConsumers(
  differences: ClassifiedDifference[],
  manifests: ConsumerManifest[],
): ImpactedDifference[] {
  return differences.map((difference) => ({
    ...difference,
    consumers: consumersFor(difference, manifests),
  }));
}
