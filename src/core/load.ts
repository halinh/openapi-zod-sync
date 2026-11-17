import SwaggerParser from '@apidevtools/swagger-parser';
import type { LoadedSpec, OpenApiDocument, OpenApiVersion } from './types.js';

export interface LoadSpecOptions {
  /** Validate the document against the OpenAPI schema (default: true). */
  validate?: boolean;
  /**
   * Allow resolving `$ref`s over HTTP(S) (default: true). Disable when the spec
   * comes from an untrusted source to avoid outbound requests.
   */
  remoteRefs?: boolean;
}

export const detectVersion = (doc: { openapi?: unknown; swagger?: unknown }): OpenApiVersion => {
  if (typeof doc.openapi === 'string') {
    if (doc.openapi.startsWith('3.1')) return '3.1';
    if (doc.openapi.startsWith('3.0')) return '3.0';
  }
  if (doc.swagger !== undefined) {
    throw new Error('Swagger 2.0 is not supported. Convert the spec to OpenAPI 3.x first (e.g. with swagger2openapi).');
  }
  throw new Error(`Unsupported or missing "openapi" version field: ${String(doc.openapi)}`);
};

/**
 * Load an OpenAPI 3.0/3.1 document from a file path, URL or in-memory object.
 * External references are bundled into the document, local `$ref`s are kept so
 * that component names survive (they become named Zod schemas).
 */
export const loadSpec = async (
  input: string | OpenApiDocument,
  options: LoadSpecOptions = {},
): Promise<LoadedSpec> => {
  const { validate = true, remoteRefs = true } = options;
  const parserOptions = { resolve: { http: remoteRefs ? {} : false } } as SwaggerParser.Options;
  const source = typeof input === 'string' ? input : undefined;
  // structuredClone: never mutate a caller-provided object.
  const raw = typeof input === 'string' ? input : structuredClone(input);

  const fail = (error: unknown): never => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid OpenAPI document${source ? ` (${source})` : ''}: ${message}`);
  };

  let bundled: OpenApiDocument;
  try {
    bundled = (await SwaggerParser.bundle(raw as never, parserOptions)) as unknown as OpenApiDocument;
  } catch (error) {
    return fail(error);
  }
  const version = detectVersion(bundled);

  if (validate) {
    // validate() dereferences in place, so give it a copy.
    try {
      await SwaggerParser.validate(structuredClone(bundled) as never, parserOptions);
    } catch (error) {
      fail(error);
    }
  }

  return { document: bundled, version, ...(source ? { source } : {}) };
};
