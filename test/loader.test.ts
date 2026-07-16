import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadSpec, SpecLoadError } from '../src/loader.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('loadSpec', () => {
  it('loads a YAML spec and reports its source', async () => {
    const { source, spec } = await loadSpec(fixture('petstore-old.yaml'));

    expect(source).toContain('petstore-old.yaml');
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info.version).toBe('1.0.0');
    expect(Object.keys(spec.paths ?? {})).toContain('/pets');
  });

  it('dereferences $refs in place', async () => {
    const { spec } = await loadSpec(fixture('petstore-old.yaml'));

    // /pets/{petId} get 200 is a $ref to components.schemas.Pet in the source.
    const schema = (spec as any).paths['/pets/{petId}'].get.responses['200'].content[
      'application/json'
    ].schema;

    expect(schema.$ref).toBeUndefined();
    expect(schema.properties.name.type).toBe('string');
  });

  it('throws SpecLoadError for a file that does not exist', async () => {
    await expect(loadSpec(fixture('does-not-exist.yaml'))).rejects.toBeInstanceOf(SpecLoadError);
  });
});
