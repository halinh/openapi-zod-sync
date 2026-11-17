/**
 * Shared types. OpenAPI schema objects are kept deliberately loose: specs in the
 * wild contain vendor extensions and both 3.0 and 3.1 dialects.
 */

export type OpenApiVersion = '3.0' | '3.1';

export interface SchemaObject {
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  const?: unknown;
  nullable?: boolean;
  description?: string;
  default?: unknown;
  // string
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  // number
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  multipleOf?: number;
  // array
  items?: SchemaObject;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  // object
  properties?: Record<string, SchemaObject>;
  required?: string[];
  additionalProperties?: boolean | SchemaObject;
  // composition
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  discriminator?: { propertyName: string; mapping?: Record<string, string> };
  readOnly?: boolean;
  writeOnly?: boolean;
  [key: string]: unknown;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; [key: string]: unknown };
  paths?: Record<string, Record<string, unknown> | undefined>;
  components?: { schemas?: Record<string, SchemaObject>; [key: string]: unknown };
  [key: string]: unknown;
}

export interface LoadedSpec {
  document: OpenApiDocument;
  version: OpenApiVersion;
  /** Where the spec was loaded from, when known. */
  source?: string;
}

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Which part of an operation a schema describes. */
export type PartKind = 'params' | 'query' | 'headers' | 'body' | 'response';

/**
 * Comparison context: request parts drop readOnly properties, responses drop
 * writeOnly ones, components keep everything.
 */
export type SchemaMode = 'request' | 'response' | 'component';

export interface OperationPart {
  kind: PartKind;
  /** Response status code ("200", "4XX", "default") for kind === 'response'. */
  status?: string;
  /** Stable key such as "body", "query" or "response.200". */
  key: string;
  mediaType?: string;
  schema: SchemaObject;
}

export interface OperationInfo {
  operationId: string;
  /** True when the spec did not define an operationId and we derived one. */
  syntheticId: boolean;
  method: HttpMethod;
  path: string;
  tags: string[];
  summary?: string;
  deprecated: boolean;
  parts: OperationPart[];
}

export interface OperationSelector {
  /** Select everything (default when no other filter is given). */
  all?: boolean;
  operationIds?: string[];
  tags?: string[];
  /** Glob patterns over paths: `*` matches one segment, `**` any number. */
  paths?: string[];
  methods?: string[];
  includeDeprecated?: boolean;
}

export type Severity = 'error' | 'warning' | 'info';

export type IssueCode =
  | 'MISSING_FIELD'
  | 'EXTRA_FIELD'
  | 'TYPE_MISMATCH'
  | 'OPTIONALITY_MISMATCH'
  | 'NULLABILITY_MISMATCH'
  | 'ENUM_MISMATCH'
  | 'FORMAT_MISMATCH'
  | 'CONSTRAINT_MISMATCH'
  | 'MISSING_SCHEMA'
  | 'UNCOMPARABLE';

export interface Issue {
  code: IssueCode;
  severity: Severity;
  /** Location inside the schema, e.g. "items[].address.zip". Empty string = root. */
  path: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
  /** Actionable fix hint, written so a human or an AI agent can apply it directly. */
  suggestion?: string;
}
