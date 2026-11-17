import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const fixture = (name: string): string => resolve(__dirname, 'fixtures', name);

export const PETSTORE = fixture('petstore-3.1.yaml');
export const EDGE_CASES = fixture('edge-cases-3.0.yaml');

/** Fresh temp dir inside the repo so generated files can resolve the local `zod`. */
export const tempDir = (prefix: string): string => {
  const base = resolve(__dirname, '.tmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${prefix}-`));
};
