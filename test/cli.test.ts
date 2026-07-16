import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoUrl = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const TSX = repoUrl('../node_modules/tsx/dist/cli.mjs');
const CLI = repoUrl('../src/cli.ts');
const OLD = repoUrl('./fixtures/petstore-old.yaml');
const NEW = repoUrl('./fixtures/petstore-new.yaml');
const CONSUMERS = repoUrl('./fixtures/consumers');
const BAD_CONSUMERS = repoUrl('./fixtures/consumers-invalid');

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run the CLI through tsx so tests don't depend on `npm run build` first. */
async function run(...args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [TSX, CLI, ...args]);
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

describe('cli diff', () => {
  it('prints a report and exits 1 when breaking changes are found', async () => {
    const { stdout, code } = await run('diff', OLD, NEW, '--fail-on', 'breaking');

    expect(stdout).toContain('BREAKING');
    expect(stdout).toMatch(/\d+ breaking, \d+ warning, \d+ non-breaking/);
    expect(code).toBe(1);
  });

  it('exits 0 with --fail-on none even when breaking changes exist', async () => {
    const { code } = await run('diff', OLD, NEW, '--fail-on', 'none');

    expect(code).toBe(0);
  });

  it('emits a well-formed JSON report with --json', async () => {
    const { stdout } = await run('diff', OLD, NEW, '--json', '--fail-on', 'none');
    const report = JSON.parse(stdout);

    expect(report.oldSource).toContain('petstore-old.yaml');
    expect(Array.isArray(report.differences)).toBe(true);
    expect(report.summary).toHaveProperty('BREAKING');
    for (const difference of report.differences) {
      expect(['BREAKING', 'WARNING', 'NON_BREAKING']).toContain(difference.severity);
    }
  });

  it('exits 2 with a readable message when a spec file is missing', async () => {
    const { stderr, code } = await run('diff', repoUrl('./fixtures/nope.yaml'), NEW);

    expect(stderr).toContain('Could not read spec file');
    expect(code).toBe(2);
  });

  it('exits 2 on an invalid --fail-on value', async () => {
    const { stderr, code } = await run('diff', OLD, NEW, '--fail-on', 'banana');

    expect(stderr).toContain('Invalid --fail-on value');
    expect(code).toBe(2);
  });
});

describe('cli diff --consumers', () => {
  it('names the affected service under a breaking change', async () => {
    const { stdout } = await run('diff', OLD, NEW, '--consumers', CONSUMERS, '--fail-on', 'none');

    expect(stdout).toContain('Affected: checkout-service');
    expect(stdout).toContain('properties.species');
  });

  it('lists the consumers it loaded, so an empty result is legible', async () => {
    const { stdout } = await run('diff', OLD, NEW, '--consumers', CONSUMERS, '--fail-on', 'none');

    expect(stdout).toContain('consumers: checkout-service, inventory-service, reporting-service');
  });

  it('says nothing about consumers when no manifests are given', async () => {
    const { stdout } = await run('diff', OLD, NEW, '--fail-on', 'none');

    expect(stdout).not.toContain('Affected:');
    expect(stdout).not.toContain('consumers:');
  });

  it('carries the impact into the JSON report', async () => {
    const { stdout } = await run('diff', OLD, NEW, '--consumers', CONSUMERS, '--json', '--fail-on', 'none');
    const report = JSON.parse(stdout);

    expect(report.knownConsumers).toEqual([
      'checkout-service',
      'inventory-service',
      'reporting-service',
    ]);

    const species = report.differences.find((d: { location: string }) =>
      d.location.endsWith('properties.species'),
    );
    expect(species.consumers).toEqual(['inventory-service']);
  });

  it('omits knownConsumers entirely when no manifests are given', async () => {
    const { stdout } = await run('diff', OLD, NEW, '--json', '--fail-on', 'none');
    const report = JSON.parse(stdout);

    expect(report).not.toHaveProperty('knownConsumers');
    expect(report.differences.every((d: { consumers: string[] }) => d.consumers.length === 0)).toBe(true);
  });

  it('exits 2 with a readable message when the consumers directory is missing', async () => {
    const { stderr, code } = await run('diff', OLD, NEW, '--consumers', repoUrl('./fixtures/nope'));

    expect(stderr).toContain('Could not read consumers directory');
    expect(code).toBe(2);
  });

  it('leaves exit codes to severity, not to who is affected', async () => {
    const { code } = await run('diff', OLD, NEW, '--consumers', CONSUMERS, '--fail-on', 'breaking');

    expect(code).toBe(1);
  });
});

describe('cli diff with invalid manifests', () => {
  it('exits 2, the same as any other unusable input', async () => {
    const { code } = await run('diff', OLD, NEW, '--consumers', BAD_CONSUMERS, '--fail-on', 'none');

    expect(code).toBe(2);
  });

  it('produces no drift report at all', async () => {
    const { stdout } = await run('diff', OLD, NEW, '--consumers', BAD_CONSUMERS, '--fail-on', 'none');

    // A report whose impact section is unreliable is worse than no report:
    // "0 consumers affected" reads as "safe to ship".
    expect(stdout).toBe('');
  });

  it('withholds the report in JSON mode too, where a script would parse it', async () => {
    const { stdout, code } = await run('diff', OLD, NEW, '--consumers', BAD_CONSUMERS, '--json');

    expect(stdout).toBe('');
    expect(code).toBe(2);
  });

  it('reports every problem, not just the first', async () => {
    const { stderr } = await run('diff', OLD, NEW, '--consumers', BAD_CONSUMERS, '--fail-on', 'none');

    expect(stderr).toContain('6 problems in consumer manifests');
  });

  it('names the consumer and the file for each problem', async () => {
    const { stderr } = await run('diff', OLD, NEW, '--consumers', BAD_CONSUMERS, '--fail-on', 'none');

    expect(stderr).toContain('typo-path-service');
    expect(stderr).toContain('bad-path.json');
    expect(stderr).toContain('uses[0].path: "/petz" is not a path in the spec');
  });

  it('points at the exact line of a manifest, not just the file', async () => {
    const { stderr } = await run('diff', OLD, NEW, '--consumers', BAD_CONSUMERS, '--fail-on', 'none');

    expect(stderr).toContain('uses[0].reads[1]: "nmae" is not in any response of get /pets/{petId}');
    expect(stderr).toContain('uses[0].method: "put" is not defined on "/pets"');
  });

  it('groups several problems under the one manifest they came from', async () => {
    const { stderr } = await run('diff', OLD, NEW, '--consumers', BAD_CONSUMERS, '--fail-on', 'none');

    expect(stderr).toContain('confused-service');
    expect(stderr).toContain('uses[0].reads[1]: "colour"');
    expect(stderr).toContain('uses[2].path: "/nope"');
  });

  it('says how to get a report anyway', async () => {
    const { stderr } = await run('diff', OLD, NEW, '--consumers', BAD_CONSUMERS, '--fail-on', 'none');

    expect(stderr).toContain('drop --consumers');
  });

  it('still diffs the specs when the bad manifests are left out', async () => {
    const { stdout, code } = await run('diff', OLD, NEW, '--fail-on', 'none');

    expect(stdout).toContain('9 breaking');
    expect(code).toBe(0);
  });
});
