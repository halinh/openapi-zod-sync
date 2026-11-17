import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createJiti } from 'jiti';
import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { generate } from '../src/generator/index.js';
import { check } from '../src/validator/check.js';
import { EDGE_CASES, PETSTORE, tempDir } from './helpers.js';

/**
 * The key guarantee: generated schemas always pass `check` against the spec
 * they were generated from — for every option combination that changes code.
 */
describe.each([
  ['petstore 3.1', PETSTORE],
  ['edge cases 3.0', EDGE_CASES],
])('round-trip: %s', (_name, spec) => {
  it.each([
    ['defaults', {}],
    ['strict objects + no coercion', { strictObjects: true, coerceParams: false }],
    ['registered meta', { register: true }],
  ])('generate → check is clean (%s)', async (_label, options) => {
    const dir = tempDir('roundtrip');
    const output = join(dir, 'schemas.ts');
    await generate(spec, { ...options, output });
    const report = await check(spec, { schemas: [output] });
    const problems = report.results.filter((r) => r.issues.length > 0);
    expect(problems).toEqual([]);
    expect(report.summary.missing).toBe(0);
    expect(report.summary.ok).toBe(report.summary.targets);
  });
});

describe('generated code', () => {
  it('type-checks under strict TypeScript', async () => {
    const dir = tempDir('tsc');
    await generate(PETSTORE, { output: join(dir, 'petstore.ts') });
    await generate(EDGE_CASES, { output: join(dir, 'edge.ts') });
    const tsc = resolve(__dirname, '../node_modules/typescript/bin/tsc');
    // Throws (failing the test) with the compiler output when there are errors.
    execFileSync(
      process.execPath,
      [tsc, '--noEmit', '--strict', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--skipLibCheck', join(dir, 'petstore.ts'), join(dir, 'edge.ts')],
      { stdio: 'pipe' },
    );
  }, 60000);

  it('validates real payloads', async () => {
    const dir = tempDir('runtime');
    const output = join(dir, 'schemas.ts');
    await generate(PETSTORE, { output });
    const s = (await createJiti(import.meta.url, { moduleCache: false }).import(output)) as Record<string, ZodType>;
    const ok = (name: string, value: unknown): boolean => s[name]!.safeParse(value).success;

    expect(ok('CreatePetBody', { name: 'Rex', status: 'available' })).toBe(true);
    expect(ok('CreatePetBody', { name: '', status: 'available' })).toBe(false); // minLength
    expect(ok('CreatePetBody', { name: 'Rex', status: 'lost' })).toBe(false); // enum
    expect(ok('CreatePetBody', { name: 'Rex', status: 'sold', tags: ['a', 'a'] })).toBe(false); // uniqueItems
    expect(ok('CreatePetResponse201', { id: 1, name: 'Rex', status: 'sold', owner: null })).toBe(true); // nullable
    expect(ok('CreatePetResponse201', { id: 1, name: 'Rex', status: 'sold', owner: { email: 'nope' } })).toBe(false);
    expect(ok('ListPetsResponse200', { items: [], total: 0, next: 'https://x.dev/p2' })).toBe(true);
    expect(ok('PlaceOrderBody', { petId: 1, quantity: 1, payment: { method: 'bank', iban: 'FR76' } })).toBe(true);
    expect(ok('PlaceOrderBody', { petId: 1, quantity: 1, payment: { method: 'cash' } })).toBe(false);
    expect(ok('ListCategoriesResponse200', [{ name: 'a', children: [{ name: 'b', children: [] }] }])).toBe(true);
    expect(s.ListPetsQuery!.parse({ limit: '5', includeArchived: 'false' })).toEqual({ limit: 5, includeArchived: false });
    expect(s.ListPetsQuery!.parse({})).toEqual({ limit: 20 });
    expect(ok('GetPetParams', { petId: '0' })).toBe(false); // minimum: 1 after coercion
  });
});
