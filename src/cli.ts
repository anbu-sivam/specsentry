#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { ManifestLoadError } from './consumers.js';
import { detectDrift } from './index.js';
import { SpecLoadError } from './loader.js';
import { ManifestValidationError } from './validate.js';
import type { ManifestProblem } from './validate.js';
import type { DriftReport, Severity } from './types.js';

const SEVERITY_LABEL: Record<Severity, string> = {
  BREAKING: 'BREAKING    ',
  WARNING: 'WARNING     ',
  NON_BREAKING: 'NON_BREAKING',
};

function renderText(report: DriftReport): string {
  const lines: string[] = [];
  lines.push(`old: ${report.oldSource}`);
  lines.push(`new: ${report.newSource}`);
  if (report.knownConsumers !== undefined) {
    lines.push(`consumers: ${report.knownConsumers.join(', ') || 'none declared'}`);
  }
  lines.push('');

  if (report.differences.length === 0) {
    lines.push('No differences found.');
  } else {
    for (const difference of report.differences) {
      lines.push(`${SEVERITY_LABEL[difference.severity]}  ${difference.location}`);
      lines.push(`              ${difference.message}`);
      if (difference.consumers.length > 0) {
        lines.push(`              Affected: ${difference.consumers.join(', ')}`);
      }
    }
    lines.push('');
  }

  const { BREAKING, WARNING, NON_BREAKING } = report.summary;
  lines.push(`${BREAKING} breaking, ${WARNING} warning, ${NON_BREAKING} non-breaking`);
  return lines.join('\n');
}

/**
 * Manifest problems are the user's input being wrong, not the API having
 * changed, so they are reported on their own terms rather than as findings.
 */
function renderProblems(problems: ManifestProblem[]): string {
  const byFile = new Map<string, ManifestProblem[]>();
  for (const problem of problems) {
    const existing = byFile.get(problem.source);
    if (existing === undefined) byFile.set(problem.source, [problem]);
    else existing.push(problem);
  }

  const noun = problems.length === 1 ? 'problem' : 'problems';
  const lines = [`${problems.length} ${noun} in consumer manifests:`, ''];

  for (const [source, group] of byFile) {
    lines.push(`  ${group[0]?.consumer} — ${source}`);
    for (const problem of group) {
      lines.push(`    ${problem.at}: ${problem.message}`);
    }
    lines.push('');
  }

  lines.push('No report produced. Fix the manifests above, or drop --consumers');
  lines.push('to diff the specs without attributing impact.');
  return lines.join('\n');
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('api-contract-drift')
    .description('Detect breaking vs non-breaking changes between two OpenAPI 3.x specs')
    .version('0.1.0');

  program
    .command('diff')
    .description('Compare an old spec against a new one')
    .argument('<old>', 'path to the old OpenAPI spec (YAML or JSON)')
    .argument('<new>', 'path to the new OpenAPI spec (YAML or JSON)')
    .option('--json', 'emit the report as JSON instead of text', false)
    .option(
      '--consumers <dir>',
      'directory of consumer manifests; names which services each change affects',
    )
    .option(
      '--fail-on <severity>',
      'exit non-zero when a change at or above this severity is found: breaking | warning | none',
      'breaking',
    )
    .action(
      async (
        oldPath: string,
        newPath: string,
        options: { json: boolean; failOn: string; consumers?: string },
      ) => {
        const failOn = options.failOn.toLowerCase();
        if (!['breaking', 'warning', 'none'].includes(failOn)) {
          console.error(
            `Invalid --fail-on value: ${options.failOn} (expected breaking, warning, or none)`,
          );
          process.exitCode = 2;
          return;
        }

        let report: DriftReport;
        try {
          report = await detectDrift(oldPath, newPath, { consumersDir: options.consumers });
        } catch (error) {
          if (error instanceof ManifestValidationError) {
            console.error(renderProblems(error.problems));
            process.exitCode = 2;
            return;
          }
          if (error instanceof SpecLoadError || error instanceof ManifestLoadError) {
            console.error(error.message);
            process.exitCode = 2;
            return;
          }
          throw error;
        }

        console.log(options.json ? JSON.stringify(report, null, 2) : renderText(report));

        const tripped =
          (failOn === 'breaking' && report.summary.BREAKING > 0) ||
          (failOn === 'warning' && report.summary.BREAKING + report.summary.WARNING > 0);
        if (tripped) {
          process.exitCode = 1;
        }
      },
    );

  return program;
}

/** Only auto-run when invoked as the entrypoint, so tests can import buildProgram. */
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
  await buildProgram().parseAsync(process.argv);
}
