import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConsumerManifests, ManifestLoadError } from '../src/consumers.js';

const fixtureDir = fileURLToPath(new URL('./fixtures/consumers', import.meta.url));

/** Write manifests to a scratch directory, keyed by filename. */
async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'acd-consumers-'));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(dir, name), contents, 'utf8');
  }
  return dir;
}

const manifestJson = (consumer: string, uses: unknown[] = [{ path: '/pets', method: 'get' }]) =>
  JSON.stringify({ consumer, uses });

describe('loadConsumerManifests', () => {
  it('loads every manifest in the directory', async () => {
    const manifests = await loadConsumerManifests(fixtureDir);

    expect(manifests.map((m) => m.consumer)).toEqual([
      'checkout-service',
      'inventory-service',
      'reporting-service',
    ]);
  });

  it('reads the declared usage of each endpoint', async () => {
    const manifests = await loadConsumerManifests(fixtureDir);
    const checkout = manifests.find((m) => m.consumer === 'checkout-service');

    expect(checkout?.uses).toEqual([
      { path: '/pets/{petId}', method: 'get', reads: ['id', 'name', 'tag'], sends: [] },
      { path: '/pets/{petId}', method: 'delete', reads: [], sends: [] },
    ]);
  });

  it('records the file each manifest came from', async () => {
    const manifests = await loadConsumerManifests(fixtureDir);

    expect(manifests[0]?.source).toContain('checkout-service.json');
  });

  it('returns manifests in filename order, whatever the directory reports', async () => {
    const dir = await dirWith({
      'zebra.json': manifestJson('zebra'),
      'alpha.json': manifestJson('alpha'),
      'middle.json': manifestJson('middle'),
    });

    const manifests = await loadConsumerManifests(dir);

    expect(manifests.map((m) => m.consumer)).toEqual(['alpha', 'middle', 'zebra']);
  });

  it('ignores files that are not JSON', async () => {
    const dir = await dirWith({
      'real.json': manifestJson('real'),
      'README.md': '# not a manifest',
      'notes.txt': 'nor this',
    });

    expect(await loadConsumerManifests(dir)).toHaveLength(1);
  });

  it('returns nothing for an empty directory', async () => {
    expect(await loadConsumerManifests(await dirWith({}))).toEqual([]);
  });

  it('defaults reads and sends to empty when a usage omits them', async () => {
    const dir = await dirWith({ 'a.json': manifestJson('a', [{ path: '/pets', method: 'get' }]) });

    const [manifest] = await loadConsumerManifests(dir);

    expect(manifest?.uses[0]).toMatchObject({ reads: [], sends: [] });
  });

  it('accepts an uppercase method and normalises it', async () => {
    const dir = await dirWith({ 'a.json': manifestJson('a', [{ path: '/pets', method: 'GET' }]) });

    const [manifest] = await loadConsumerManifests(dir);

    expect(manifest?.uses[0]?.method).toBe('get');
  });
});

describe('loadConsumerManifests rejects', () => {
  const expectRejection = async (files: Record<string, string>, message: string) => {
    const dir = await dirWith(files);
    await expect(loadConsumerManifests(dir)).rejects.toThrow(message);
    await expect(loadConsumerManifests(dir)).rejects.toBeInstanceOf(ManifestLoadError);
  };

  it('a directory that does not exist', async () => {
    await expect(loadConsumerManifests(join(tmpdir(), 'acd-not-here'))).rejects.toBeInstanceOf(
      ManifestLoadError,
    );
  });

  it('malformed JSON', async () => {
    await expectRejection({ 'a.json': '{ not json' }, 'not valid JSON');
  });

  it('a missing consumer name', async () => {
    await expectRejection({ 'a.json': JSON.stringify({ uses: [] }) }, '"consumer" must be');
  });

  it('a missing uses array', async () => {
    await expectRejection({ 'a.json': JSON.stringify({ consumer: 'a' }) }, '"uses" must be');
  });

  it('a path that is not a path', async () => {
    await expectRejection(
      { 'a.json': manifestJson('a', [{ path: 'pets', method: 'get' }]) },
      'must start with "/"',
    );
  });

  it('a method that is not an HTTP method', async () => {
    await expectRejection(
      { 'a.json': manifestJson('a', [{ path: '/pets', method: 'fetch' }]) },
      'not an HTTP method',
    );
  });

  it('a field list that is not a list', async () => {
    await expectRejection(
      { 'a.json': manifestJson('a', [{ path: '/pets', method: 'get', reads: 'id' }]) },
      'must be an array',
    );
  });

  it('two files claiming the same consumer name', async () => {
    // The name is how a finding reports who it hits, so a collision would make
    // the attribution unreadable rather than merely redundant.
    await expectRejection(
      { 'a.json': manifestJson('same-name'), 'b.json': manifestJson('same-name') },
      'Duplicate consumer "same-name"',
    );
  });
});
