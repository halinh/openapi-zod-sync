import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgram, EXIT } from '../src/cli/index.js';
import pkg from '../package.json' with { type: 'json' };
import { VERSION } from '../src/version.js';
import { PETSTORE, tempDir } from './helpers.js';

const runCli = async (args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> => {
  let stdout = '';
  let stderr = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((stdout += String(chunk)), true));
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => ((stderr += String(chunk)), true));
  const previous = process.cwd();
  if (cwd) process.chdir(cwd);
  process.exitCode = 0;
  try {
    await createProgram().exitOverride().parseAsync(['node', 'openapi-zod-sync', ...args]);
  } finally {
    if (cwd) process.chdir(previous);
    out.mockRestore();
    err.mockRestore();
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { code, stdout, stderr };
};

afterEach(() => {
  process.exitCode = 0;
});

describe('cli', () => {
  it('lists operations as JSON', async () => {
    const { code, stdout } = await runCli(['list', PETSTORE, '--json', '--tag', 'store']);
    expect(code).toBe(EXIT.ok);
    expect(JSON.parse(stdout).map((op: { operationId: string }) => op.operationId)).toEqual(['placeOrder', 'listCategories']);
  });

  it('generates selected operations (comma or space separated)', async () => {
    const dir = tempDir('cli-gen');
    const output = join(dir, 'api.ts');
    const { code } = await runCli(['generate', PETSTORE, '-o', output, '--operation', 'getPet,createPet']);
    expect(code).toBe(EXIT.ok);
    const content = readFileSync(output, 'utf8');
    expect(content).toContain('export const GetPetParams');
    expect(content).toContain('export const CreatePetBody');
    expect(content).not.toContain('ListPetsQuery');
  });

  it('--stdout never writes the configured output file', async () => {
    const dir = tempDir('cli-stdout');
    const output = join(dir, 'out.ts');
    const config = join(dir, 'cfg.json');
    writeFileSync(config, JSON.stringify({ generate: { output } }));
    const { code, stdout } = await runCli(['-c', config, 'generate', PETSTORE, '--operation', 'getPet', '--stdout']);
    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain('export const GetPetParams');
    expect(existsSync(output)).toBe(false);
  });

  it('exits 1 on drift and 0 with --fail-on never; writes markdown reports', async () => {
    const example = resolve(__dirname, '../examples/petstore');
    const failing = await runCli(['check', '--format', 'json'], example);
    expect(failing.code).toBe(EXIT.drift);
    expect(JSON.parse(failing.stdout).summary.errors).toBeGreaterThan(0);

    const dir = tempDir('cli-report');
    const out = join(dir, 'report.md');
    const passing = await runCli(['check', '--fail-on', 'never', '--format', 'markdown', '--out', out], example);
    expect(passing.code).toBe(EXIT.ok);
    expect(readFileSync(out, 'utf8')).toContain('# OpenAPI ⇄ Zod sync report');
  });

  it('returns exit code 2 on usage errors', async () => {
    const { code, stderr } = await runCli(['check', PETSTORE]);
    expect(code).toBe(EXIT.error);
    expect(stderr).toContain('No schema files given');
  });

  it('creates a config with init', async () => {
    const dir = tempDir('cli-init');
    expect((await runCli(['init'], dir)).code).toBe(EXIT.ok);
    expect(existsSync(join(dir, 'openapi-zod-sync.config.ts'))).toBe(true);
    expect((await runCli(['init'], dir)).code).toBe(EXIT.error);
  });

  it('keeps VERSION in sync with package.json', () => {
    expect(VERSION).toBe(pkg.version);
  });
});
