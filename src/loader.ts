import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { load as parseYaml } from 'js-yaml';
import type { OpenAPI } from 'openapi-types';
import type { LoadedSpec, OpenApiSpec } from './types.js';

export class SpecLoadError extends Error {
  constructor(
    message: string,
    readonly source: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SpecLoadError';
  }
}

/**
 * Read a spec file and hand back a fully dereferenced document.
 *
 * We parse the file ourselves (js-yaml handles JSON too, since JSON is a YAML
 * subset) so that syntax errors surface with our own file context, then let
 * swagger-parser resolve $refs. Relative $refs resolve against the spec's own
 * directory, which is why the absolute path is passed through as the base.
 */
export async function loadSpec(filePath: string): Promise<LoadedSpec> {
  const source = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);

  let text: string;
  try {
    text = await readFile(source, 'utf8');
  } catch (cause) {
    throw new SpecLoadError(`Could not read spec file: ${source}`, source, cause);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (cause) {
    throw new SpecLoadError(`Spec is not valid YAML or JSON: ${source}`, source, cause);
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new SpecLoadError(`Spec did not parse to an object: ${source}`, source);
  }

  try {
    const dereferenced = await SwaggerParser.dereference(source, parsed as OpenAPI.Document, {});
    return { source, spec: dereferenced as unknown as OpenApiSpec };
  } catch (cause) {
    throw new SpecLoadError(`Could not dereference spec: ${source}`, source, cause);
  }
}
