import { classify, sortBySeverity, summarize } from './classifier.js';
import { loadConsumerManifests } from './consumers.js';
import { diffSpecs } from './differ.js';
import { attributeConsumers } from './impact.js';
import { loadSpec } from './loader.js';
import { ManifestValidationError, validateManifests } from './validate.js';
import type { ConsumerManifest, DriftReport } from './types.js';

export interface DetectDriftOptions {
  /** Directory of consumer manifests. Without it, no impact is attributed. */
  consumersDir?: string;
}

/** Full pipeline: load both specs, diff them, classify, then attribute impact. */
export async function detectDrift(
  oldPath: string,
  newPath: string,
  options: DetectDriftOptions = {},
): Promise<DriftReport> {
  const [oldSpec, newSpec, manifests] = await Promise.all([
    loadSpec(oldPath),
    loadSpec(newPath),
    options.consumersDir === undefined
      ? Promise.resolve<ConsumerManifest[] | undefined>(undefined)
      : loadConsumerManifests(options.consumersDir),
  ]);

  // Refuse to report rather than attribute impact from manifests that describe
  // an API that does not exist. A wrong "0 consumers affected" reads as "safe
  // to ship", which is the one answer this tool must never get wrong.
  if (manifests !== undefined) {
    const problems = validateManifests(manifests, oldSpec.spec);
    if (problems.length > 0) throw new ManifestValidationError(problems);
  }

  const classified = classify(diffSpecs(oldSpec, newSpec));
  const differences = sortBySeverity(attributeConsumers(classified, manifests ?? []));

  return {
    oldSource: oldSpec.source,
    newSource: newSpec.source,
    ...(manifests === undefined
      ? {}
      : { knownConsumers: manifests.map((manifest) => manifest.consumer).sort() }),
    differences,
    summary: summarize(differences),
  };
}

export { classify, sortBySeverity, summarize } from './classifier.js';
export { loadConsumerManifests, ManifestLoadError } from './consumers.js';
export { diffSpecs } from './differ.js';
export { attributeConsumers } from './impact.js';
export { loadSpec, SpecLoadError } from './loader.js';
export { RULES, ruleFor } from './rules.js';
export type { ImpactScope, Rule } from './rules.js';
export { ManifestValidationError, validateManifests } from './validate.js';
export type { ManifestProblem } from './validate.js';
export type * from './types.js';
