import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { diffSpecs } from '../src/differ.js';
import { loadSpec } from '../src/loader.js';
import { RULES } from '../src/rules.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('diffSpecs', () => {
  // The differ is still a stub, so these assert the contract it must honour
  // rather than any specific finding. Replace with real cases once it walks
  // the specs for real.
  it('emits differences whose kinds all exist in the rules table', async () => {
    const oldSpec = await loadSpec(fixture('petstore-old.yaml'));
    const newSpec = await loadSpec(fixture('petstore-new.yaml'));

    const differences = diffSpecs(oldSpec, newSpec);

    expect(differences.length).toBeGreaterThan(0);
    for (const difference of differences) {
      expect(RULES[difference.kind], `unknown kind: ${difference.kind}`).toBeDefined();
      expect(difference.location).not.toBe('');
    }
  });
});
