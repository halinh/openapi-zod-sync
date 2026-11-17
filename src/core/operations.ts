import { derefObject } from './refs.js';
import { syntheticOperationId } from './naming.js';
import { HTTP_METHODS } from './types.js';
import type { HttpMethod, OpenApiDocument, OperationInfo, OperationPart, SchemaObject } from './types.js';

interface ParameterObject {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  deprecated?: boolean;
  schema?: SchemaObject;
  content?: Record<string, { schema?: SchemaObject }>;
}

interface MediaTypeObject {
  schema?: SchemaObject;
}

interface RawOperation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  deprecated?: boolean;
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
}

const isJsonMediaType = (mediaType: string): boolean => {
  const base = mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
  return base === 'application/json' || base.endsWith('+json') || base === '*/*';
};

/** Pick the most relevant media type: JSON first, otherwise the first one with a schema. */
const pickMedia = (
  content: Record<string, MediaTypeObject> | undefined,
): { mediaType: string; schema: SchemaObject } | undefined => {
  if (!content) return undefined;
  const entries = Object.entries(content).filter(([, media]) => media && media.schema);
  const chosen = entries.find(([type]) => isJsonMediaType(type)) ?? entries[0];
  return chosen ? { mediaType: chosen[0], schema: chosen[1].schema as SchemaObject } : undefined;
};

const parameterSchema = (param: ParameterObject): SchemaObject | undefined => {
  if (param.schema) return param.schema;
  return pickMedia(param.content)?.schema;
};

/** Merge path-level and operation-level parameters (operation wins on name+in). */
const mergeParameters = (doc: OpenApiDocument, pathLevel: unknown[], opLevel: unknown[]): ParameterObject[] => {
  const merged = new Map<string, ParameterObject>();
  for (const raw of [...pathLevel, ...opLevel]) {
    const param = derefObject<ParameterObject | undefined>(doc, raw as ParameterObject);
    if (!param || typeof param.name !== 'string') continue;
    merged.set(`${param.in}:${param.name}`, param);
  }
  return [...merged.values()];
};

/** Build a synthetic object schema describing one parameter location. */
const parametersToSchema = (params: ParameterObject[], lowerCaseKeys: boolean): SchemaObject | undefined => {
  if (params.length === 0) return undefined;
  const properties: Record<string, SchemaObject> = {};
  const required: string[] = [];
  for (const param of params) {
    const key = lowerCaseKeys ? param.name.toLowerCase() : param.name;
    const schema = parameterSchema(param) ?? {};
    properties[key] =
      param.description && !schema.$ref && !schema.description ? { ...schema, description: param.description } : schema;
    if (param.required || param.in === 'path') required.push(key);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
};

const buildParts = (doc: OpenApiDocument, pathItem: Record<string, unknown>, op: RawOperation): OperationPart[] => {
  const parts: OperationPart[] = [];
  const params = mergeParameters(doc, (pathItem.parameters as unknown[]) ?? [], op.parameters ?? []);

  const locations = [
    { in: 'path', kind: 'params', lower: false },
    { in: 'query', kind: 'query', lower: false },
    // HTTP header names are case-insensitive; Node exposes them lower-cased.
    { in: 'header', kind: 'headers', lower: true },
  ] as const;
  for (const location of locations) {
    const schema = parametersToSchema(
      params.filter((p) => p.in === location.in),
      location.lower,
    );
    if (schema) parts.push({ kind: location.kind, key: location.kind, schema });
  }

  const body = derefObject<{ content?: Record<string, MediaTypeObject>; required?: boolean } | undefined>(
    doc,
    op.requestBody as never,
  );
  const bodyMedia = pickMedia(body?.content);
  if (bodyMedia) parts.push({ kind: 'body', key: 'body', mediaType: bodyMedia.mediaType, schema: bodyMedia.schema });

  for (const [status, rawResponse] of Object.entries(op.responses ?? {})) {
    const response = derefObject<{ content?: Record<string, MediaTypeObject> } | undefined>(doc, rawResponse as never);
    const media = pickMedia(response?.content);
    if (media) {
      parts.push({ kind: 'response', status, key: `response.${status}`, mediaType: media.mediaType, schema: media.schema });
    }
  }
  return parts;
};

/** Flatten all operations of a document into a stable, ordered list. */
export const listOperations = (doc: OpenApiDocument): OperationInfo[] => {
  const operations: OperationInfo[] = [];
  const usedIds = new Map<string, number>();
  for (const [path, rawPathItem] of Object.entries(doc.paths ?? {})) {
    const pathItem = derefObject<Record<string, unknown> | undefined>(doc, rawPathItem);
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method] as RawOperation | undefined;
      if (!op || typeof op !== 'object') continue;
      const syntheticId = typeof op.operationId !== 'string' || op.operationId.length === 0;
      let operationId = syntheticId ? syntheticOperationId(method, path) : (op.operationId as string);
      // Ensure uniqueness even for broken specs with duplicated ids.
      const count = usedIds.get(operationId) ?? 0;
      usedIds.set(operationId, count + 1);
      if (count > 0) operationId = `${operationId}${count + 1}`;
      operations.push({
        operationId,
        syntheticId,
        method: method as HttpMethod,
        path,
        tags: op.tags ?? [],
        ...(op.summary ? { summary: op.summary } : {}),
        deprecated: op.deprecated === true,
        parts: buildParts(doc, pathItem, op),
      });
    }
  }
  return operations;
};
