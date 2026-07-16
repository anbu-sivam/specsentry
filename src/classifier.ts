import { ruleFor } from './rules.js';
import { suggestionFor } from './suggestions.js';
import type { ClassifiedDifference, RawDifference, Severity } from './types.js';

const SEVERITY_ORDER: Record<Severity, number> = {
  BREAKING: 0,
  WARNING: 1,
  NON_BREAKING: 2,
};

/**
 * Attach a severity, message and suggestion to each raw difference by looking
 * its kind up. All judgement lives in src/rules.ts and src/suggestions.ts —
 * this function only performs the lookups, so keep it free of per-kind cases.
 */
export function classify(differences: RawDifference[]): ClassifiedDifference[] {
  return differences.map((difference) => {
    const rule = ruleFor(difference.kind);
    const suggestion = suggestionFor(difference);
    return {
      ...difference,
      severity: rule.severity,
      message: rule.message,
      ...(suggestion === undefined ? {} : { suggestion }),
    };
  });
}

/** Most severe first, then by location, so output is stable across runs. */
export function sortBySeverity<T extends ClassifiedDifference>(differences: T[]): T[] {
  return [...differences].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    return bySeverity !== 0 ? bySeverity : a.location.localeCompare(b.location);
  });
}

export function summarize(differences: ClassifiedDifference[]): Record<Severity, number> {
  const summary: Record<Severity, number> = { BREAKING: 0, WARNING: 0, NON_BREAKING: 0 };
  for (const difference of differences) {
    summary[difference.severity] += 1;
  }
  return summary;
}
