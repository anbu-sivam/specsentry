import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { HTTP_METHODS } from './types.js';
import type { ConsumerManifest, ConsumerUsage, HttpMethod } from './types.js';

export class ManifestLoadError extends Error {
  constructor(
    message: string,
    readonly source: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ManifestLoadError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, what: string, source: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ManifestLoadError(`${what} must be a non-empty string`, source);
  }
  return value;
}

function fieldList(value: unknown, what: string, source: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ManifestLoadError(`${what} must be an array of field names`, source);
  }
  return value.map((entry, index) => requireString(entry, `${what}[${index}]`, source));
}

function requireMethod(value: unknown, what: string, source: string): HttpMethod {
  const method = requireString(value, what, source).toLowerCase();
  if (!(HTTP_METHODS as readonly string[]).includes(method)) {
    throw new ManifestLoadError(`${what} is not an HTTP method: ${method}`, source);
  }
  return method as HttpMethod;
}

function parseUsage(value: unknown, what: string, source: string): ConsumerUsage {
  if (!isRecord(value)) {
    throw new ManifestLoadError(`${what} must be an object`, source);
  }

  const path = requireString(value.path, `${what}.path`, source);
  if (!path.startsWith('/')) {
    throw new ManifestLoadError(`${what}.path must start with "/": ${path}`, source);
  }

  return {
    path,
    method: requireMethod(value.method, `${what}.method`, source),
    reads: fieldList(value.reads, `${what}.reads`, source),
    sends: fieldList(value.sends, `${what}.sends`, source),
  };
}

function parseManifest(text: string, source: string): ConsumerManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ManifestLoadError(`Manifest is not valid JSON: ${source}`, source, cause);
  }

  if (!isRecord(parsed)) {
    throw new ManifestLoadError(`Manifest did not parse to an object: ${source}`, source);
  }

  const uses = parsed.uses;
  if (!Array.isArray(uses)) {
    throw new ManifestLoadError(`"uses" must be an array: ${source}`, source);
  }

  return {
    consumer: requireString(parsed.consumer, '"consumer"', source),
    source,
    uses: uses.map((usage, index) => parseUsage(usage, `uses[${index}]`, source)),
  };
}

/**
 * Read every `*.json` manifest in a directory.
 *
 * Files are taken in filename order so a report does not depend on how the
 * filesystem happens to enumerate them. Consumer names must be unique across
 * the set, since a name is how a finding reports who it hits — two files
 * claiming one name would silently merge into an unattributable result.
 */
export async function loadConsumerManifests(dirPath: string): Promise<ConsumerManifest[]> {
  const dir = isAbsolute(dirPath) ? dirPath : resolve(process.cwd(), dirPath);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (cause) {
    throw new ManifestLoadError(`Could not read consumers directory: ${dir}`, dir, cause);
  }

  const files = entries.filter((entry) => entry.endsWith('.json')).sort();
  const manifests: ConsumerManifest[] = [];
  const declaredIn = new Map<string, string>();

  for (const file of files) {
    const source = join(dir, file);

    let text: string;
    try {
      text = await readFile(source, 'utf8');
    } catch (cause) {
      throw new ManifestLoadError(`Could not read manifest: ${source}`, source, cause);
    }

    const manifest = parseManifest(text, source);
    const previous = declaredIn.get(manifest.consumer);
    if (previous !== undefined) {
      throw new ManifestLoadError(
        `Duplicate consumer "${manifest.consumer}": already declared in ${previous}`,
        source,
      );
    }

    declaredIn.set(manifest.consumer, source);
    manifests.push(manifest);
  }

  return manifests;
}
