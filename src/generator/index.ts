import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { loadSpec } from '../core/load.js';
import type { LoadSpecOptions } from '../core/load.js';
import type { LoadedSpec, OpenApiDocument } from '../core/types.js';
import { generateFromSpec } from './emit.js';
import type { GenerateOptions, GenerateResult } from './emit.js';

export interface GenerateToDiskOptions extends GenerateOptions, LoadSpecOptions {
  /**
   * Output target. Single-file mode: a file path (".ts" or ".js"; the extension
   * decides `typescript` unless set explicitly). Split mode: a directory.
   * Omit to only return the generated code.
   */
  output?: string;
}

export interface GenerateToDiskResult extends GenerateResult {
  /** Absolute paths written to disk. */
  written: string[];
}

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

/**
 * Load a spec, generate Zod schemas for the selected operations and optionally
 * write them to disk.
 */
export const generate = async (
  input: string | OpenApiDocument | LoadedSpec,
  options: GenerateToDiskOptions = {},
): Promise<GenerateToDiskResult> => {
  const spec =
    typeof input === 'object' && 'document' in input && 'version' in input
      ? (input as LoadedSpec)
      : await loadSpec(input as string | OpenApiDocument, options);
  const splitBy = options.splitBy ?? 'none';
  const typescript =
    options.typescript ?? !(splitBy === 'none' && options.output && JS_EXTENSIONS.has(extname(options.output)));

  const result = generateFromSpec(spec, { ...options, typescript });
  const written: string[] = [];
  if (!options.output) return { ...result, written };

  const target = resolve(options.output);
  for (const file of result.files) {
    const path = splitBy === 'none' ? target : join(target, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, 'utf8');
    written.push(path);
  }
  return { ...result, written };
};

export { generateFromSpec };
export type { GenerateOptions, GenerateResult, GeneratedExport, GeneratedFile } from './emit.js';
export { schemaToZod } from './schemaToZod.js';
export type { ZodEmitContext } from './schemaToZod.js';
