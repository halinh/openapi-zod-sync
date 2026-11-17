import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatJson, formatMarkdown, formatText } from '../src/reporter/index.js';
import { check, shouldFail } from '../src/validator/check.js';
import type { ZodExport } from '../src/validator/loadSchemas.js';
import { PETSTORE, tempDir } from './helpers.js';

const EXAMPLE = resolve(__dirname, '../examples/petstore');
const asExports = (schemas: Record<string, z.ZodType>): ZodExport[] =>
  Object.entries(schemas).map(([name, schema]) => ({ name, file: '/virtual/schemas.ts', schema }));

describe('check', () => {
  it('detects every planted drift in the example project', async () => {
    const report = await check(join(EXAMPLE, 'openapi.yaml'), {
      schemas: ['src/**/*.ts'],
      cwd: EXAMPLE,
      mapping: { 'createPet.body': 'NewPetSchema' },
    });
    const pet = report.results.find((r) => r.target === '#/components/schemas/Pet')!;
    expect(pet.match).toEqual({ export: 'PetSchema', file: 'src/schemas.ts', via: 'convention' });
    expect(pet.issues.map((i) => `${i.code}:${i.path}`)).toEqual([
      'CONSTRAINT_MISMATCH:name',
      'ENUM_MISMATCH:status',
      'CONSTRAINT_MISMATCH:tags',
      'OPTIONALITY_MISMATCH:weightKg',
      'NULLABILITY_MISMATCH:owner',
      'FORMAT_MISMATCH:owner.email',
      'CONSTRAINT_MISMATCH:owner.phone',
      'MISSING_FIELD:metadata',
      'EXTRA_FIELD:nickname',
    ]);
    const body = report.results.find((r) => r.target === 'createPet.body')!;
    expect(body.match?.via).toBe('mapping');
    expect(report.results.find((r) => r.target === 'getPet.response.200')).toMatchObject({ status: 'covered', coveredBy: 'PetSchema' });
    expect(report.results.find((r) => r.target === '#/components/schemas/Category')?.status).toBe('ok');
    expect(report.results.find((r) => r.target === 'listPets.query')!.issues.map((i) => i.code)).toEqual([
      'ENUM_MISMATCH',
      'MISSING_FIELD',
    ]);
    expect(shouldFail(report, 'error')).toBe(true);
    expect(shouldFail(report, 'never')).toBe(false);
  });

  it('matches by .meta({ openapi }) and restricts to the selection', async () => {
    const exports = asExports({
      Anything: z.object({ petId: z.coerce.number().int().min(1) }).meta({ openapi: { operationId: 'getPet', part: 'params' } }),
    });
    const report = await check(PETSTORE, { schemas: [], exports, select: { operationIds: ['getPet'] }, reportMissing: false });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({ target: 'getPet.params', status: 'ok', match: { via: 'meta' } });
  });

  it('compares headers case-insensitively', async () => {
    const exports = asExports({ ListPetsHeaders: z.object({ 'X-Request-Id': z.uuid() }) });
    const report = await check(PETSTORE, { schemas: [], exports, select: { operationIds: ['listPets'] }, reportMissing: false });
    expect(report.results.find((r) => r.target === 'listPets.headers')?.status).toBe('ok');
  });

  it('applies severity overrides and missing severity', async () => {
    const exports = asExports({ PetStatus: z.enum(['available', 'pending', 'sold', 'extra']) });
    const report = await check(PETSTORE, {
      schemas: [],
      exports,
      severity: { ENUM_MISMATCH: 'off' },
      missingSeverity: 'info',
    });
    expect(report.results.find((r) => r.component === 'PetStatus')?.status).toBe('ok');
    expect(report.summary.errors + report.summary.warnings).toBe(0);
    expect(report.summary.infos).toBe(report.summary.missing);
  });

  it('loads TypeScript modules at runtime and lists unmatched exports', async () => {
    const dir = tempDir('load');
    const file = join(dir, 'user.ts');
    writeFileSync(file, "import { z } from 'zod';\nexport const PetStatus = z.enum(['available', 'pending', 'sold']);\nexport const Unrelated = z.string();\nexport const notZod = 42;\n");
    const report = await check(PETSTORE, { schemas: [file], reportMissing: false });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.status).toBe('ok');
    expect(report.unmatchedExports.map((e) => e.name)).toEqual(['Unrelated']);
  });

  it('reports unresolved mappings instead of aborting', async () => {
    const report = await check(PETSTORE, {
      schemas: [],
      exports: asExports({}),
      select: { operationIds: ['createPet'] },
      mapping: { 'createPet.body': 'DoesNotExist' },
      reportMissing: false,
    });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.issues[0]!.message).toContain('mapped export "DoesNotExist" was not found');
  });

  it('fails clearly when no file matches', async () => {
    await expect(check(PETSTORE, { schemas: ['nope/**/*.ts'] })).rejects.toThrow(/No schema files matched/);
  });
});

describe('reporters', () => {
  it('renders text, markdown and JSON', async () => {
    const report = await check(PETSTORE, {
      schemas: [],
      exports: asExports({ PetStatus: z.enum(['available']) }),
      select: { operationIds: ['getPet'] },
    });
    const text = formatText(report, { color: false });
    expect(text).toContain('✖ #/components/schemas/PetStatus');
    expect(text).toContain('ENUM_MISMATCH');
    expect(text).toMatch(/Summary: \d+ targets/);
    const md = formatMarkdown(report);
    expect(md).toContain('| ❌ drift | `#/components/schemas/PetStatus` |');
    expect(md).toContain('### `#/components/schemas/PetStatus`');
    const json = JSON.parse(formatJson(report));
    expect(json.tool).toBe('openapi-zod-sync');
    expect(json.results[0].issues[0]).toMatchObject({ code: 'ENUM_MISMATCH', severity: 'error', suggestion: expect.any(String) });
  });
});
