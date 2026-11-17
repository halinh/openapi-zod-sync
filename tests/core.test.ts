import { describe, expect, it } from 'vitest';
import { globToRegExp } from '../src/core/glob.js';
import { detectVersion, loadSpec } from '../src/core/load.js';
import { pascalCase, partExportName, syntheticOperationId } from '../src/core/naming.js';
import { listOperations } from '../src/core/operations.js';
import { selectOperations } from '../src/core/select.js';
import { EDGE_CASES, PETSTORE } from './helpers.js';

describe('loadSpec', () => {
  it('loads 3.1 and 3.0 documents and keeps local $refs', async () => {
    const v31 = await loadSpec(PETSTORE);
    expect(v31.version).toBe('3.1');
    const v30 = await loadSpec(EDGE_CASES);
    expect(v30.version).toBe('3.0');
    const body = (v31.document.paths?.['/pets']?.post as { requestBody: { content: Record<string, { schema: unknown }> } })
      .requestBody.content['application/json']?.schema;
    expect(body).toEqual({ $ref: '#/components/schemas/Pet' });
  });

  it('rejects Swagger 2.0 and invalid documents', async () => {
    expect(() => detectVersion({ swagger: '2.0' })).toThrow(/Swagger 2.0/);
    await expect(loadSpec({ openapi: '3.1.0', info: { title: 'x' } } as never)).rejects.toThrow(/Invalid OpenAPI/);
  });

  it('does not mutate an in-memory document', async () => {
    const doc = { openapi: '3.1.0', info: { title: 't', version: '1' }, paths: {} };
    const copy = structuredClone(doc);
    await loadSpec(doc);
    expect(doc).toEqual(copy);
  });
});

describe('listOperations', () => {
  it('extracts parts, merges path-level parameters and derives missing ids', async () => {
    const { document } = await loadSpec(PETSTORE);
    const ops = listOperations(document);
    expect(ops.map((op) => op.operationId)).toEqual([
      'listPets',
      'createPet',
      'getPet',
      'deletePetsByPetId',
      'placeOrder',
      'listCategories',
    ]);
    const listPets = ops[0]!;
    expect(listPets.parts.map((p) => p.key)).toEqual(['query', 'headers', 'response.200', 'response.default']);
    // header names are lower-cased
    expect(Object.keys(listPets.parts[1]!.schema.properties ?? {})).toEqual(['x-request-id']);
    const del = ops.find((op) => op.operationId === 'deletePetsByPetId')!;
    expect(del.syntheticId).toBe(true);
    expect(del.parts[0]!.schema.required).toEqual(['petId']);
  });

  it('prefers +json media types and resolves $ref parameters', async () => {
    const { document } = await loadSpec(EDGE_CASES);
    const upload = listOperations(document).find((op) => op.operationId === 'uploadFile')!;
    expect(upload.parts.find((p) => p.kind === 'body')?.mediaType).toBe('application/vnd.api+json');
    expect(upload.parts.find((p) => p.kind === 'params')?.schema.properties?.accountId).toEqual({
      type: 'string',
      format: 'uuid',
    });
    expect(upload.parts.map((p) => p.key)).toContain('response.4XX');
  });
});

describe('selectOperations', () => {
  it('selects one, some or all endpoints', async () => {
    const ops = listOperations((await loadSpec(PETSTORE)).document);
    const ids = (sel: Parameters<typeof selectOperations>[1]): string[] => selectOperations(ops, sel).map((o) => o.operationId);
    expect(ids({})).toHaveLength(6);
    expect(ids({ all: true })).toHaveLength(6);
    expect(ids({ operationIds: ['getPet'] })).toEqual(['getPet']);
    expect(ids({ operationIds: ['getPet', 'placeOrder'] })).toEqual(['getPet', 'placeOrder']);
    expect(ids({ tags: ['store'] })).toEqual(['placeOrder', 'listCategories']);
    expect(ids({ paths: ['/pets/*'] })).toEqual(['getPet', 'deletePetsByPetId']);
    expect(ids({ paths: ['/pets/**'] })).toEqual(['listPets', 'createPet', 'getPet', 'deletePetsByPetId']);
    expect(ids({ tags: ['pets'], methods: ['POST'] })).toEqual(['createPet']);
  });

  it('fails loudly on unknown operationIds', async () => {
    const ops = listOperations((await loadSpec(PETSTORE)).document);
    expect(() => selectOperations(ops, { operationIds: ['nope'] })).toThrow(/Unknown operationId/);
  });

  it('can skip deprecated operations', async () => {
    const ops = listOperations((await loadSpec(EDGE_CASES)).document);
    expect(selectOperations(ops, { includeDeprecated: false }).map((o) => o.operationId)).not.toContain('createShape');
  });
});

describe('naming and globs', () => {
  it('builds safe identifiers', () => {
    expect(pascalCase('create-user_v2')).toBe('CreateUserV2');
    expect(pascalCase('Error')).toBe('ErrorSchema');
    expect(pascalCase('2fa')).toBe('_2fa');
    expect(syntheticOperationId('get', '/users/{id}/posts')).toBe('getUsersByIdPosts');
    expect(partExportName('createPet', { kind: 'response', status: '2XX' })).toBe('CreatePetResponse2XX');
    expect(partExportName('createPet', { kind: 'response', status: 'default' })).toBe('CreatePetResponseDefault');
  });

  it('matches globs per segment', () => {
    expect(globToRegExp('/pets/*').test('/pets/{id}')).toBe(true);
    expect(globToRegExp('/pets/*').test('/pets/{id}/photos')).toBe(false);
    expect(globToRegExp('/pets/**').test('/pets')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/c.ts')).toBe(true);
  });
});
