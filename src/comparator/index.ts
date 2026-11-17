import { toJSONSchema } from 'zod';
import type { ZodType } from 'zod';
import { componentExportName } from '../core/naming.js';
import type { Issue, OpenApiDocument, SchemaMode, SchemaObject } from '../core/types.js';
import { schemaToZod } from '../generator/schemaToZod.js';
import { diffSchemas } from './diff.js';
import type { SchemaRef } from './normalize.js';

export type ZodIo = 'input' | 'output';

export interface CompareOptions {
  /** request: ignore readOnly, response: ignore writeOnly, component: tolerate both (default). */
  mode?: SchemaMode;
  /** Document used to resolve `$ref`s in the OpenAPI schema. */
  document?: OpenApiDocument;
  /** Which side of Zod transforms/defaults to compare (default: 'output'; request bodies usually 'input'). */
  io?: ZodIo;
}

/** Convert a Zod schema to JSON Schema, tolerating unrepresentable parts. */
export const zodToJsonSchema = (schema: ZodType, io: ZodIo = 'output'): SchemaObject =>
  toJSONSchema(schema, {
    io,
    unrepresentable: 'any',
    cycles: 'ref',
    reused: 'inline',
    target: 'draft-2020-12',
  }) as SchemaObject;

/** Build a one-line Zod snippet for a contract sub-schema (used in fix suggestions). */
const suggester =
  (document: unknown) =>
  (expected: SchemaRef): string | undefined => {
    try {
      const code = schemaToZod(expected.node, {
        doc: (expected.root ?? document) as OpenApiDocument,
        version: '3.1',
        mode: 'component',
        ref: (name) => ({ identifier: componentExportName(name), deferred: false }),
        strictObjects: false,
        descriptions: false,
        warnings: [],
      });
      const oneLine = code.replace(/\s*\n\s*/g, ' ').replace(/,\s*}/g, ' }');
      return oneLine.length > 160 ? undefined : oneLine;
    } catch {
      return undefined;
    }
  };

/**
 * Compare a Zod schema with an OpenAPI schema object and list the differences.
 *
 * @example
 *   const issues = compare(UserSchema, spec.components.schemas.User, { document: spec });
 */
export const compare = (zodSchema: ZodType, openapiSchema: SchemaObject, options: CompareOptions = {}): Issue[] => {
  const { mode = 'component', document, io = 'output' } = options;
  let actual: SchemaObject;
  try {
    actual = zodToJsonSchema(zodSchema, io);
  } catch (error) {
    return [
      {
        code: 'UNCOMPARABLE',
        severity: 'warning',
        path: '',
        message: `Could not convert the Zod schema to JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
  const root = document ?? openapiSchema;
  return diffSchemas({ node: openapiSchema, root }, { node: actual, root: actual }, { mode, suggest: suggester(root) });
};

export { diffSchemas } from './diff.js';
export type { DiffOptions } from './diff.js';
export { normalize } from './normalize.js';
export type { Shape, SchemaRef } from './normalize.js';
