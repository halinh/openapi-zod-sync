import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';
import type { OperationSelector, Severity, IssueCode } from '../core/types.js';
import type { GenerateOptions } from '../generator/emit.js';
import type { ReportFormat } from '../reporter/index.js';
import type { FailOn } from '../validator/check.js';
import type { SchemaMapping } from '../validator/match.js';

export interface OpenApiZodSyncConfig {
  /** Path or URL of the OpenAPI document. */
  spec?: string;
  /** Allow resolving remote `$ref`s over HTTP(S) (default: true). */
  remoteRefs?: boolean;
  generate?: GenerateOptions & {
    /** Output file (single mode) or directory (split mode). */
    output?: string;
  };
  check?: {
    /** Files or globs of modules exporting Zod schemas. */
    schemas?: string[];
    select?: OperationSelector;
    mapping?: SchemaMapping;
    reportMissing?: boolean;
    missingSeverity?: Severity;
    severity?: Partial<Record<IssueCode, Severity | 'off'>>;
    failOn?: FailOn;
    format?: ReportFormat;
    out?: string;
  };
}

/** Identity helper that gives config files type checking and autocompletion. */
export const defineConfig = (config: OpenApiZodSyncConfig): OpenApiZodSyncConfig => config;

export const CONFIG_FILES = [
  'openapi-zod-sync.config.ts',
  'openapi-zod-sync.config.mts',
  'openapi-zod-sync.config.js',
  'openapi-zod-sync.config.mjs',
  'openapi-zod-sync.config.cjs',
  'openapi-zod-sync.config.json',
];

export interface LoadedConfig {
  config: OpenApiZodSyncConfig;
  file?: string;
}

/** Load an explicit config file, or the first conventional one found in `cwd`. */
export const loadConfig = async (explicit: string | undefined, cwd: string = process.cwd()): Promise<LoadedConfig> => {
  const file = explicit ? resolve(cwd, explicit) : CONFIG_FILES.map((f) => resolve(cwd, f)).find((f) => existsSync(f));
  if (!file) return { config: {} };
  if (!existsSync(file)) throw new Error(`Config file not found: ${file}`);
  if (file.endsWith('.json')) {
    return { config: JSON.parse(await readFile(file, 'utf8')) as OpenApiZodSyncConfig, file };
  }
  const jiti = createJiti(pathToFileURL(`${cwd}/`).href, { moduleCache: false, fsCache: false });
  const mod = (await jiti.import(file)) as { default?: OpenApiZodSyncConfig } & OpenApiZodSyncConfig;
  return { config: mod.default ?? mod, file };
};

export const CONFIG_TEMPLATE = `import { defineConfig } from 'openapi-zod-sync';

export default defineConfig({
  spec: './openapi.yaml',
  generate: {
    output: './src/schemas/api.ts',
    // select: { tags: ['pets'] },        // one, some or all endpoints (default: all)
    // splitBy: 'tag',                    // one file per tag (output must be a directory)
    // register: true,                    // attach .meta({ openapi }) for robust matching
  },
  check: {
    schemas: ['./src/schemas/**/*.ts'],
    failOn: 'error',
    // mapping: { 'createPet.body': 'NewPetSchema', '#/components/schemas/Pet': 'PetSchema' },
    // severity: { CONSTRAINT_MISMATCH: 'off' },
  },
});
`;
