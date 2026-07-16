#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { detectDrift } from './index.js';
import { SpecLoadError } from './loader.js';
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
  lines.push('');

  if (report.differences.length === 0) {
    lines.push('No differences found.');
  } else {
    for (const difference of report.differences) {
      lines.push(`${SEVERITY_LABEL[difference.severity]}  ${difference.location}`);
      lines.push(`              ${difference.message}`);
    }
    lines.push('');
  }

  const { BREAKING, WARNING, NON_BREAKING } = report.summary;
  lines.push(`${BREAKING} breaking, ${WARNING} warning, ${NON_BREAKING} non-breaking`);
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
      '--fail-on <severity>',
      'exit non-zero when a change at or above this severity is found: breaking | warning | none',
      'breaking',
    )
    .action(async (oldPath: string, newPath: string, options: { json: boolean; failOn: string }) => {
      const failOn = options.failOn.toLowerCase();
      if (!['breaking', 'warning', 'none'].includes(failOn)) {
        console.error(`Invalid --fail-on value: ${options.failOn} (expected breaking, warning, or none)`);
        process.exitCode = 2;
        return;
      }

      let report: DriftReport;
      try {
        report = await detectDrift(oldPath, newPath);
      } catch (error) {
        if (error instanceof SpecLoadError) {
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
    });

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
