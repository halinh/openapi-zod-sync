/**
 * openapi-zod-sync — keep your OpenAPI contracts and Zod schemas in sync.
 *
 *   generate()  OpenAPI → Zod source code (one, some or all operations)
 *   check()     existing Zod schemas vs OpenAPI → drift report
 *   compare()   one Zod schema vs one OpenAPI schema object → issues
 */

// core
export { loadSpec, detectVersion } from './core/load.js';
export type { LoadSpecOptions } from './core/load.js';
export { listOperations } from './core/operations.js';
export { selectOperations } from './core/select.js';
export { partExportName, componentExportName } from './core/naming.js';
export type * from './core/types.js';

// generator
export { generate, generateFromSpec, schemaToZod } from './generator/index.js';
export type {
  GenerateOptions,
  GenerateResult,
  GeneratedExport,
  GeneratedFile,
  ZodEmitContext,
} from './generator/index.js';
export type { GenerateToDiskOptions, GenerateToDiskResult } from './generator/index.js';

// comparator
export { compare, zodToJsonSchema } from './comparator/index.js';
export type { CompareOptions, ZodIo } from './comparator/index.js';

// validator
export { check, shouldFail, loadZodExports, isZodSchema } from './validator/index.js';
export type {
  CheckOptions,
  CheckReport,
  CheckSummary,
  CheckTargetResult,
  FailOn,
  SchemaMapping,
  TargetStatus,
  ZodExport,
} from './validator/index.js';

// reporter
export { formatReport, formatJson, formatMarkdown, formatText, formatOperations } from './reporter/index.js';
export type { ReportFormat, TextReportOptions } from './reporter/index.js';

// config
export { defineConfig } from './cli/config.js';
export type { OpenApiZodSyncConfig } from './cli/config.js';

export { VERSION } from './version.js';
