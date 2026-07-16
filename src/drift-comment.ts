import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { DiffTarget, DriftReport, ImpactedDifference } from './types.js';

/**
 * Renders a drift report as the body of a pull request comment, for
 * .github/workflows/api-contract-drift.yml.
 *
 * Lives in src/ rather than beside the workflow so it is typechecked against
 * DriftReport and reachable from the test suite.
 */

/** Lets the workflow find its own previous comment and edit it. Kept in sync by a test. */
export const COMMENT_MARKER = '<!-- api-contract-drift -->';

function endpointOf(target: DiffTarget | undefined): string {
  if (target?.path === undefined) return '';
  return target.method === undefined
    ? `\`${target.path}\``
    : `${target.method.toUpperCase()} \`${target.path}\``;
}

function describe(difference: ImpactedDifference, consumersKnown: boolean): string {
  const endpoint = endpointOf(difference.target);
  const field = difference.target?.field?.length
    ? ` \`${difference.target.field.join('.')}\``
    : '';
  const heading = endpoint === '' ? '`info.version`' : `${endpoint}${field}`;

  const lines = [`- **${heading}**`, `  ${difference.message}`];
  if (difference.consumers.length > 0) {
    lines.push(`  Affects: **${difference.consumers.join('**, **')}**`);
  } else if (consumersKnown) {
    lines.push('  No declared consumer.');
  }
  if (difference.suggestion !== undefined) {
    lines.push(`  _Suggest: ${difference.suggestion}_`);
  }
  return lines.join('\n');
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function renderDriftComment(report: DriftReport, specPath: string): string {
  const consumersKnown = report.knownConsumers !== undefined;
  const breaking = report.differences.filter((d) => d.severity === 'BREAKING');
  const warnings = report.differences.filter((d) => d.severity === 'WARNING');
  const lines = [COMMENT_MARKER];

  if (breaking.length === 0) {
    lines.push('## No breaking API changes');
    lines.push('');
    lines.push(`\`${specPath}\` has no changes that break existing callers.`);
    if (warnings.length > 0) {
      lines.push('');
      lines.push(`${plural(warnings.length, 'warning')}:`);
      lines.push('');
      lines.push(warnings.map((d) => describe(d, consumersKnown)).join('\n'));
    }
    return lines.join('\n');
  }

  lines.push(`## ${plural(breaking.length, 'breaking change')} in \`${specPath}\``);
  lines.push('');
  lines.push('These break services that call this API as it exists on the base branch.');
  lines.push('');
  lines.push(breaking.map((d) => describe(d, consumersKnown)).join('\n'));

  if (warnings.length > 0) {
    lines.push('');
    lines.push('<details>');
    lines.push(`<summary>${plural(warnings.length, 'warning')}</summary>`);
    lines.push('');
    lines.push(warnings.map((d) => describe(d, consumersKnown)).join('\n'));
    lines.push('');
    lines.push('</details>');
  }

  lines.push('');
  const { BREAKING, WARNING, NON_BREAKING } = report.summary;
  lines.push(`${BREAKING} breaking, ${WARNING} warning, ${NON_BREAKING} non-breaking.`);
  lines.push(
    consumersKnown && report.knownConsumers !== undefined
      ? `Consumers checked: ${report.knownConsumers.join(', ')}. A manifest set is what is known, not proof of who else calls this.`
      : 'No consumer manifests were given, so nobody is named above.',
  );

  return lines.join('\n');
}

/** Only auto-run when invoked as the entrypoint, so tests can import the renderer. */
function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const [reportPath, specPath = 'the spec'] = process.argv.slice(2);
  if (reportPath === undefined) {
    console.error('usage: drift-comment.js <report.json> [spec-path]');
    process.exitCode = 1;
  } else {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as DriftReport;
    process.stdout.write(`${renderDriftComment(report, specPath)}\n`);
  }
}
