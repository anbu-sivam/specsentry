import { classify, sortBySeverity, summarize } from './classifier.js';
import { diffSpecs } from './differ.js';
import { loadSpec } from './loader.js';
import type { DriftReport } from './types.js';

/** Full pipeline: load both specs, diff them, classify the result. */
export async function detectDrift(oldPath: string, newPath: string): Promise<DriftReport> {
  const [oldSpec, newSpec] = await Promise.all([loadSpec(oldPath), loadSpec(newPath)]);
  const differences = sortBySeverity(classify(diffSpecs(oldSpec, newSpec)));

  return {
    oldSource: oldSpec.source,
    newSource: newSpec.source,
    differences,
    summary: summarize(differences),
  };
}

export { classify, sortBySeverity, summarize } from './classifier.js';
export { diffSpecs } from './differ.js';
export { loadSpec, SpecLoadError } from './loader.js';
export { RULES, ruleFor } from './rules.js';
export type { Rule } from './rules.js';
export type * from './types.js';
