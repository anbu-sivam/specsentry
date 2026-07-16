import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { COMMENT_MARKER, renderDriftComment } from '../src/drift-comment.js';
import { detectDrift } from '../src/index.js';
import type { DriftReport } from '../src/types.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const OLD = fixture('petstore-old.yaml');
const NEW = fixture('petstore-new.yaml');
const CONSUMERS = fixture('consumers');

/**
 * Reports come from the real pipeline, not hand-built literals. The renderer's
 * whole job is reading what detectDrift actually produces, so a fake report
 * could drift from the real shape and take these tests with it.
 */
let drifted: DriftReport;
let withoutManifests: DriftReport;
let clean: DriftReport;

beforeAll(async () => {
  [drifted, withoutManifests, clean] = await Promise.all([
    detectDrift(OLD, NEW, { consumersDir: CONSUMERS }),
    detectDrift(OLD, NEW),
    detectDrift(OLD, OLD, { consumersDir: CONSUMERS }),
  ]);
});

describe('renderDriftComment on a breaking report', () => {
  it('leads with the count and the spec that changed', () => {
    const body = renderDriftComment(drifted, 'api/openapi.yaml');

    expect(body).toContain('## 9 breaking changes in `api/openapi.yaml`');
  });

  it('names the consumer a breaking change reaches', () => {
    const body = renderDriftComment(drifted, 'spec.yaml');

    expect(body).toContain('- **DELETE `/pets/{petId}`**\n  Method removed from an existing path; calls will fail.\n  Affects: **checkout-service**');
  });

  it('names the consumer that breaks on a field it never declared', () => {
    const body = renderDriftComment(drifted, 'spec.yaml');

    // inventory-service sends `name` only; the new required `species` breaks it
    // precisely because its payload omits it.
    expect(body).toContain('- **POST `/pets` `species`**\n  New required property in request body; existing payloads will be rejected.\n  Affects: **inventory-service**');
  });

  it('says so plainly when a breaking change reaches nobody declared', () => {
    const body = renderDriftComment(drifted, 'spec.yaml');

    // Pet.tag goes from the /pets listing too, but no manifest reads it there.
    expect(body).toContain('- **GET `/pets` `tag`**\n  Property removed from response; clients reading it will find it missing.\n  No declared consumer.');
  });

  it('lists more than one consumer when a change reaches several', () => {
    const body = renderDriftComment(drifted, 'spec.yaml');

    expect(body).toContain('Affects: **checkout-service**, **reporting-service**');
  });

  it('suggests a fix under a breaking change', () => {
    const body = renderDriftComment(drifted, 'spec.yaml');

    expect(body).toContain(
      '  _Suggest: Add `species` as optional with a server-side default, and require it once senders have migrated._',
    );
  });

  it('says which parameter changed, not just which endpoint', () => {
    const body = renderDriftComment(drifted, 'spec.yaml');

    expect(body).toContain('- **GET `/pets` (parameter `limit`)**');
    // The heading used to stop at the endpoint, leaving the reader to guess.
    expect(body).not.toContain('- **GET `/pets`**\n  Parameter changed');
  });

  it('marks a parameter as one, so it does not read as a body field', () => {
    const body = renderDriftComment(drifted, 'spec.yaml');

    expect(body).toContain('(parameter `limit`)');
    expect(body).toContain('- **POST `/pets` `species`**');
  });

  it('names the parameter in the suggestion too', () => {
    const body = renderDriftComment(drifted, 'spec.yaml');

    expect(body).toContain(
      '_Suggest: Keep `limit` optional and default it server-side; require it only in a new API version._',
    );
  });

  it('suggests nothing under a warning', () => {
    const body = renderDriftComment(drifted, 'spec.yaml');
    const deprecation = body.slice(body.indexOf('Operation marked deprecated'));

    expect(deprecation.split('\n')[1]).not.toContain('_Suggest:');
  });

  it('folds warnings away behind a summary', () => {
    const body = renderDriftComment(drifted, 'spec.yaml');

    expect(body).toContain('<summary>4 warnings</summary>');
    expect(body).toContain('Operation marked deprecated');
  });

  it('closes with the counts and who was checked', () => {
    const body = renderDriftComment(drifted, 'spec.yaml');

    expect(body).toContain('9 breaking, 4 warning, 4 non-breaking.');
    expect(body).toContain(
      'Consumers checked: checkout-service, inventory-service, reporting-service.',
    );
  });

  it('mentions no consumer that the report did not name', () => {
    const body = renderDriftComment(drifted, 'spec.yaml');
    const affected = body.split('\n').filter((line) => line.startsWith('  Affects:'));

    // reporting-service reads only Pet.name, which never moved, so it appears
    // against the deprecation and nothing else.
    expect(affected.filter((line) => line.includes('reporting-service'))).toHaveLength(1);
  });
});

describe('renderDriftComment without manifests', () => {
  it('attributes nothing to anybody', () => {
    const body = renderDriftComment(withoutManifests, 'spec.yaml');

    expect(body).not.toContain('Affects:');
    expect(body).not.toContain('No declared consumer.');
  });

  it('says why nobody is named, rather than implying nobody is affected', () => {
    const body = renderDriftComment(withoutManifests, 'spec.yaml');

    expect(body).toContain('No consumer manifests were given, so nobody is named above.');
    expect(body).not.toContain('Consumers checked:');
  });

  it('still reports the breaking changes themselves', () => {
    const body = renderDriftComment(withoutManifests, 'spec.yaml');

    expect(body).toContain('## 9 breaking changes');
    expect(body).toContain('9 breaking, 4 warning, 4 non-breaking.');
  });
});

describe('renderDriftComment on a clean report', () => {
  it('says there is nothing breaking', () => {
    const body = renderDriftComment(clean, 'api/openapi.yaml');

    expect(body).toContain('## No breaking API changes');
    expect(body).toContain('`api/openapi.yaml` has no changes that break existing callers.');
  });

  it('does not render a breaking section or a summary line', () => {
    const body = renderDriftComment(clean, 'spec.yaml');

    expect(body).not.toContain('breaking change');
    expect(body).not.toContain('<details>');
    expect(body).not.toContain('0 breaking, 0 warning, 0 non-breaking.');
  });
});

describe('renderDriftComment always', () => {
  it('starts with the marker the workflow looks for', () => {
    for (const report of [drifted, withoutManifests, clean]) {
      expect(renderDriftComment(report, 'spec.yaml').startsWith(COMMENT_MARKER)).toBe(true);
    }
  });

  it('uses the same marker the workflow greps for', () => {
    // The workflow can't import this module — it inlines the string. If the two
    // ever diverge, every push posts a new comment instead of editing its own.
    const workflow = readFileSync(
      fileURLToPath(new URL('../.github/workflows/api-contract-drift.yml', import.meta.url)),
      'utf8',
    );

    expect(workflow).toContain(COMMENT_MARKER);
  });

  it('calls the built script the workflow actually runs', () => {
    const workflow = readFileSync(
      fileURLToPath(new URL('../.github/workflows/api-contract-drift.yml', import.meta.url)),
      'utf8',
    );

    expect(workflow).toContain('node head/dist/drift-comment.js');
  });
});
