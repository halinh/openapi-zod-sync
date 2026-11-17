import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createJiti } from 'jiti';
import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { loadSpec } from '../src/core/load.js';
import type { OpenApiDocument, SchemaMode, SchemaObject } from '../src/core/types.js';
import { generate, generateFromSpec, schemaToZod } from '../src/generator/index.js';
import { PETSTORE, tempDir } from './helpers.js';

const doc: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  components: { schemas: { Pet: { type: 'object' } } },
};

const emit = (schema: SchemaObject, mode: SchemaMode = 'component', version: '3.0' | '3.1' = '3.1'): string =>
  schemaToZod(schema, {
    doc,
    version,
    mode,
    ref: (name) => ({ identifier: name, deferred: false }),
    strictObjects: false,
    descriptions: true,
    warnings: [],
  });

describe('schemaToZod', () => {
  it.each<[string, SchemaObject, string]>([
    ['string bounds', { type: 'string', minLength: 1, maxLength: 5 }, 'z.string().min(1).max(5)'],
    ['email', { type: 'string', format: 'email' }, 'z.email()'],
    ['date-time accepts offsets', { type: 'string', format: 'date-time' }, 'z.iso.datetime({ offset: true })'],
    ['uri', { type: 'string', format: 'uri' }, 'z.url()'],
    ['pattern', { type: 'string', pattern: '^a/b$' }, 'z.string().regex(new RegExp("^a/b$"))'],
    ['integer', { type: 'integer', minimum: 0, maximum: 10 }, 'z.int().min(0).max(10)'],
    ['3.1 exclusive', { type: 'number', exclusiveMinimum: 0, multipleOf: 0.5 }, 'z.number().gt(0).multipleOf(0.5)'],
    ['3.0 exclusive', { type: 'number', minimum: 0, exclusiveMinimum: true }, 'z.number().gt(0)'],
    ['string enum', { type: 'string', enum: ['a', 'b'] }, 'z.enum(["a", "b"])'],
    ['number enum', { type: 'integer', enum: [1, 2] }, 'z.union([z.literal(1), z.literal(2)])'],
    ['enum with null', { type: 'string', enum: ['a', 'b', null] }, 'z.enum(["a", "b"]).nullable()'],
    ['const', { const: 'x' }, 'z.literal("x")'],
    ['3.0 nullable', { type: 'string', nullable: true }, 'z.string().nullable()'],
    ['3.1 type array', { type: ['string', 'null'] }, 'z.string().nullable()'],
    ['multi type', { type: ['string', 'integer'] }, 'z.union([z.string(), z.int()])'],
    ['array', { type: 'array', items: { type: 'string' }, minItems: 1 }, 'z.array(z.string()).min(1)'],
    ['record', { type: 'object', additionalProperties: { type: 'number' } }, 'z.record(z.string(), z.number())'],
    ['free object', { type: 'object' }, 'z.record(z.string(), z.unknown())'],
    ['empty schema', {}, 'z.unknown()'],
    ['ref', { $ref: '#/components/schemas/Pet' }, 'Pet'],
    ['anyOf with null', { anyOf: [{ $ref: '#/components/schemas/Pet' }, { type: 'null' }] }, 'Pet.nullable()'],
    ['default', { type: 'boolean', default: false }, 'z.boolean().default(false)'],
    ['describe', { type: 'string', description: 'Name' }, 'z.string().describe("Name")'],
  ])('%s', (_name, schema, expected) => {
    expect(emit(schema)).toBe(expected);
  });

  it('emits objects with optional, quoted and strict keys', () => {
    const code = emit({
      type: 'object',
      required: ['id'],
      additionalProperties: false,
      properties: { id: { type: 'integer' }, 'x-tag': { type: 'string' } },
    });
    expect(code).toBe('z.strictObject({\n  id: z.int(),\n  "x-tag": z.string().optional(),\n})');
  });

  it('drops readOnly properties in requests and writeOnly in responses', () => {
    const schema: SchemaObject = {
      type: 'object',
      properties: { id: { type: 'integer', readOnly: true }, password: { type: 'string', writeOnly: true } },
    };
    expect(emit(schema, 'request')).not.toContain('id:');
    expect(emit(schema, 'request')).toContain('password:');
    expect(emit(schema, 'response')).toContain('id:');
    expect(emit(schema, 'response')).not.toContain('password:');
  });

  it('flags unsupported keywords instead of dropping them silently', () => {
    const warnings: string[] = [];
    const code = schemaToZod(
      { type: 'string', not: { const: 'x' } },
      { doc, version: '3.1', mode: 'component', ref: (n) => ({ identifier: n, deferred: false }), strictObjects: false, descriptions: true, warnings },
    );
    expect(code).toContain('/* openapi-zod-sync: ignored not */');
    expect(warnings).toHaveLength(1);
  });
});

describe('generateFromSpec', () => {
  it('generates only the selected operations and the components they need', async () => {
    const spec = await loadSpec(PETSTORE);
    const result = generateFromSpec(spec, { select: { operationIds: ['listCategories'] } });
    const content = result.files[0]!.content;
    expect(content).toContain('export const ListCategoriesResponse200 = z.array(Category);');
    expect(content).toContain('get children()');
    expect(content).not.toContain('export const Pet ');
    expect(result.exports.map((e) => e.name)).toEqual(['Category', 'ListCategoriesResponse200']);
  });

  it('creates request variants for components with readOnly/writeOnly fields', async () => {
    const result = generateFromSpec(await loadSpec(PETSTORE), { select: { operationIds: ['createPet', 'placeOrder'] } });
    const content = result.files[0]!.content;
    expect(content).toContain('export const CreatePetBody = PetInput;');
    expect(content).toContain('export const CreatePetResponse201 = Pet;');
    expect(content).toMatch(/export const CardPaymentInput = z\.object\(\{\n {2}method: z\.literal\("card"\),\n {2}cardNumber/);
    expect(content).toContain('z.discriminatedUnion("method", [CardPaymentInput, BankPayment])');
  });

  it('supports JS output, meta registration and no operations map', async () => {
    const result = generateFromSpec(await loadSpec(PETSTORE), {
      select: { operationIds: ['getPet'] },
      typescript: false,
      register: true,
      operationsMap: false,
    });
    expect(result.files[0]!.path).toBe('schemas.js');
    const content = result.files[0]!.content;
    expect(content).not.toContain('export type');
    expect(content).not.toContain('export const operations');
    expect(content).toContain('.meta({ openapi: { operationId: "getPet", part: "params" } })');
  });

  it('splits output by tag with cross-file imports', async () => {
    const dir = tempDir('split');
    const result = await generate(PETSTORE, { splitBy: 'tag', output: dir });
    expect(result.files.map((f) => f.path).sort()).toEqual(['components.ts', 'index.ts', 'pets.ts', 'store.ts']);
    const pets = readFileSync(join(dir, 'pets.ts'), 'utf8');
    expect(pets).toMatch(/import \{ ErrorSchema, Pet, PetInput, PetStatus \} from '\.\/components\.js';/);
    const jiti = createJiti(import.meta.url, { moduleCache: false });
    const mod = (await jiti.import(join(dir, 'index.ts'))) as Record<string, unknown>;
    const operations = mod.operations as Record<string, { responses: Record<string, ZodType> }>;
    expect(operations.getPet!.responses['200']!.safeParse({ id: 1, name: 'Rex', status: 'sold' }).success).toBe(true);
  });
});
