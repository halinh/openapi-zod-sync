import { pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';
import type { ZodType } from 'zod';
import { expandFilePatterns } from '../core/glob.js';

export interface OpenApiMeta {
  operationId?: string;
  part?: string;
  component?: string;
  variant?: 'input';
}

export interface ZodExport {
  name: string;
  /** Absolute file path. */
  file: string;
  schema: ZodType;
  /** `.meta({ openapi })` attached to the schema, if any. */
  meta?: OpenApiMeta;
}

/** Duck-typed check that works across Zod instances (user code may bundle its own copy). */
export const isZodSchema = (value: unknown): value is ZodType =>
  Boolean(value) &&
  typeof value === 'object' &&
  '_zod' in (value as object) &&
  typeof (value as { safeParse?: unknown }).safeParse === 'function';

export const readMeta = (schema: ZodType): OpenApiMeta | undefined => {
  try {
    // `.meta()` without arguments returns the metadata from the schema's own registry.
    const meta = (schema as unknown as { meta?: () => unknown }).meta?.();
    const openapi = meta && typeof meta === 'object' ? (meta as { openapi?: unknown }).openapi : undefined;
    return openapi && typeof openapi === 'object' ? (openapi as OpenApiMeta) : undefined;
  } catch {
    return undefined;
  }
};

export interface LoadZodExportsOptions {
  cwd?: string;
}

/**
 * Import user modules at runtime (TypeScript supported through jiti) and
 * collect every exported Zod schema.
 *
 * SECURITY: this executes the target modules. Only point it at trusted code.
 */
export const loadZodExports = async (patterns: string[], options: LoadZodExportsOptions = {}): Promise<ZodExport[]> => {
  const cwd = options.cwd ?? process.cwd();
  const files = expandFilePatterns(patterns, cwd);
  if (files.length === 0) {
    throw new Error(`No schema files matched: ${patterns.join(', ')}`);
  }
  const jiti = createJiti(pathToFileURL(`${cwd}/`).href, { interopDefault: false, moduleCache: false, fsCache: false });
  const exports: ZodExport[] = [];
  for (const file of files) {
    let mod: Record<string, unknown>;
    try {
      mod = (await jiti.import(file)) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Failed to load schema module ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const [name, value] of Object.entries(mod)) {
      if (!isZodSchema(value)) continue;
      const meta = readMeta(value);
      exports.push({ name, file, schema: value, ...(meta ? { meta } : {}) });
    }
  }
  return exports;
};
