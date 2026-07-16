#!/usr/bin/env node
/**
 * Render a drift report as the body of a pull request comment.
 *
 * Split out of the workflow so it can be run against a saved report and eyeballed:
 *   node .github/scripts/drift-comment.mjs report.json
 *
 * Reads `target` rather than parsing `location`: the location string is built
 * for humans and cannot be taken apart reliably, while target carries the path,
 * method and field as data.
 */
import { readFileSync } from 'node:fs';

/** Lets the workflow find its own previous comment instead of posting a new one each push. */
const MARKER = '<!-- api-contract-drift -->';

function endpointOf(target) {
  if (target?.path === undefined) return '';
  return target.method === undefined
    ? `\`${target.path}\``
    : `${target.method.toUpperCase()} \`${target.path}\``;
}

function describe(difference, consumersKnown) {
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
  return lines.join('\n');
}

function render(report, specPath) {
  const consumersKnown = report.knownConsumers !== undefined;
  const breaking = report.differences.filter((d) => d.severity === 'BREAKING');
  const warnings = report.differences.filter((d) => d.severity === 'WARNING');
  const lines = [MARKER];

  if (breaking.length === 0) {
    lines.push('## No breaking API changes');
    lines.push('');
    lines.push(`\`${specPath}\` has no changes that break existing callers.`);
    if (warnings.length > 0) {
      lines.push('');
      lines.push(`${warnings.length} warning${warnings.length === 1 ? '' : 's'}:`);
      lines.push('');
      lines.push(warnings.map((d) => describe(d, consumersKnown)).join('\n'));
    }
    return lines.join('\n');
  }

  const noun = breaking.length === 1 ? 'breaking change' : 'breaking changes';
  lines.push(`## ${breaking.length} ${noun} in \`${specPath}\``);
  lines.push('');
  lines.push('These break services that call this API as it exists on the base branch.');
  lines.push('');
  lines.push(breaking.map((d) => describe(d, consumersKnown)).join('\n'));

  if (warnings.length > 0) {
    lines.push('');
    lines.push('<details>');
    lines.push(`<summary>${warnings.length} warning${warnings.length === 1 ? '' : 's'}</summary>`);
    lines.push('');
    lines.push(warnings.map((d) => describe(d, consumersKnown)).join('\n'));
    lines.push('');
    lines.push('</details>');
  }

  lines.push('');
  const { BREAKING, WARNING, NON_BREAKING } = report.summary;
  lines.push(`${BREAKING} breaking, ${WARNING} warning, ${NON_BREAKING} non-breaking.`);
  lines.push(
    consumersKnown
      ? `Consumers checked: ${report.knownConsumers.join(', ')}. A manifest set is what is known, not proof of who else calls this.`
      : 'No consumer manifests were given, so nobody is named above.',
  );

  return lines.join('\n');
}

const [reportPath, specPath = 'the spec'] = process.argv.slice(2);
if (reportPath === undefined) {
  console.error('usage: drift-comment.mjs <report.json> [spec-path]');
  process.exit(1);
}

process.stdout.write(`${render(JSON.parse(readFileSync(reportPath, 'utf8')), specPath)}\n`);
