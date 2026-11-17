import { STRING_FORMAT_FACTORIES } from '../core/formats.js';
import { propertyKey } from '../core/naming.js';
import { componentNameFromRef, derefSchema, resolvePointer } from '../core/refs.js';
import type { OpenApiDocument, OpenApiVersion, SchemaMode, SchemaObject } from '../core/types.js';

export interface RefTarget {
  identifier: string;
  /** The referenced schema is not initialised yet (cycle/forward ref): access it lazily. */
  deferred: boolean;
}

export interface ZodEmitContext {
  doc: OpenApiDocument;
  version: OpenApiVersion;
  mode: SchemaMode;
  /** Resolve a component reference to an identifier, recording the dependency. */
  ref: (componentName: string, mode: SchemaMode) => RefTarget;
  strictObjects: boolean;
  descriptions: boolean;
  warnings: string[];
}

interface WalkState {
  ctx: ZodEmitContext;
  /** Current location used in warnings, e.g. "createPet.body.tags[]". */
  location: string;
  indent: number;
  /** Inside an object getter: deferred references can be accessed directly. */
  inGetter: boolean;
  /** Coerce primitives (query/path/header values arrive as strings). */
  coerce: boolean;
  /** Counter of deferred references seen, used to decide getter emission. */
  deferredHits: { count: number };
  /** Guards against infinite inlining of non-component local refs. */
  inlineDepth: number;
}

const UNSUPPORTED_KEYWORDS = [
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'minProperties',
  'maxProperties',
  'contains',
  'prefixItems',
  'dependentRequired',
  'dependentSchemas',
  'unevaluatedProperties',
  'unevaluatedItems',
] as const;

const literal = (value: unknown): string => JSON.stringify(value);
const pad = (indent: number): string => '  '.repeat(indent);

const isNullSchema = (schema: SchemaObject): boolean =>
  schema.type === 'null' || (Array.isArray(schema.enum) && schema.enum.length === 1 && schema.enum[0] === null);

const isNullable = (schema: SchemaObject): boolean =>
  schema.nullable === true ||
  (Array.isArray(schema.type) && schema.type.includes('null')) ||
  (Array.isArray(schema.enum) && schema.enum.includes(null));

const nonNullTypes = (schema: SchemaObject): string[] => {
  if (Array.isArray(schema.type)) return schema.type.filter((t) => t !== 'null');
  return typeof schema.type === 'string' && schema.type !== 'null' ? [schema.type] : [];
};

/** Infer a type from keywords when `type` is omitted. */
const inferType = (schema: SchemaObject): string | undefined => {
  if (schema.properties || schema.additionalProperties !== undefined) return 'object';
  if (schema.items) return 'array';
  if (schema.minLength !== undefined || schema.maxLength !== undefined || schema.pattern || schema.format) return 'string';
  if (schema.minimum !== undefined || schema.maximum !== undefined || schema.multipleOf !== undefined) return 'number';
  return undefined;
};

/** Should this property be hidden in the current mode (readOnly in requests, writeOnly in responses)? */
export const isHiddenInMode = (doc: OpenApiDocument, schema: SchemaObject, mode: SchemaMode): boolean => {
  const resolved = derefSchema(doc, schema);
  const readOnly = schema.readOnly === true || resolved.readOnly === true;
  const writeOnly = schema.writeOnly === true || resolved.writeOnly === true;
  return (mode === 'request' && readOnly) || (mode === 'response' && writeOnly);
};

const child = (state: WalkState, location: string, extra: Partial<WalkState> = {}): WalkState => ({
  ...state,
  location,
  coerce: false,
  ...extra,
});

const emitRef = (schema: SchemaObject & { $ref: string }, state: WalkState): string => {
  const name = componentNameFromRef(schema.$ref);
  if (name !== undefined) {
    const target = state.ctx.ref(name, state.ctx.mode);
    if (target.deferred) {
      state.deferredHits.count++;
      return state.inGetter ? target.identifier : `z.lazy(() => ${target.identifier})`;
    }
    return target.identifier;
  }
  // Non-component local ref (e.g. "#/components/schemas/Pet/properties/id"): inline it.
  const resolved = resolvePointer(state.ctx.doc, schema.$ref);
  if (!resolved || typeof resolved !== 'object' || state.inlineDepth > 20) {
    state.ctx.warnings.push(`${state.location}: could not resolve $ref "${schema.$ref}", using z.unknown()`);
    return 'z.unknown()';
  }
  return emitSchema(resolved as SchemaObject, { ...state, inlineDepth: state.inlineDepth + 1 });
};

const emitEnum = (values: unknown[]): string => {
  const present = values.filter((v) => v !== null);
  if (present.length === 0) return 'z.null()';
  if (present.length === 1) return `z.literal(${literal(present[0])})`;
  if (present.every((v) => typeof v === 'string')) return `z.enum([${present.map(literal).join(', ')}])`;
  return `z.union([${present.map((v) => `z.literal(${literal(v)})`).join(', ')}])`;
};

const emitString = (schema: SchemaObject): string => {
  let code = (schema.format && STRING_FORMAT_FACTORIES[schema.format]) || 'z.string()';
  if (schema.minLength !== undefined) code += `.min(${schema.minLength})`;
  if (schema.maxLength !== undefined) code += `.max(${schema.maxLength})`;
  if (schema.pattern) code += `.regex(new RegExp(${literal(schema.pattern)}))`;
  return code;
};

const emitNumber = (schema: SchemaObject, integer: boolean, state: WalkState): string => {
  let code = state.coerce ? (integer ? 'z.coerce.number().int()' : 'z.coerce.number()') : integer ? 'z.int()' : 'z.number()';
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum } = schema;
  // OpenAPI 3.0: boolean exclusive flags modify minimum/maximum. 3.1: numeric bounds.
  if (minimum !== undefined) code += exclusiveMinimum === true ? `.gt(${minimum})` : `.min(${minimum})`;
  if (typeof exclusiveMinimum === 'number') code += `.gt(${exclusiveMinimum})`;
  if (maximum !== undefined) code += exclusiveMaximum === true ? `.lt(${maximum})` : `.max(${maximum})`;
  if (typeof exclusiveMaximum === 'number') code += `.lt(${exclusiveMaximum})`;
  if (schema.multipleOf !== undefined) code += `.multipleOf(${schema.multipleOf})`;
  return code;
};

const emitArray = (schema: SchemaObject, state: WalkState): string => {
  const items = schema.items ? emitSchema(schema.items, child(state, `${state.location}[]`)) : 'z.unknown()';
  let code = `z.array(${items})`;
  if (schema.minItems !== undefined) code += `.min(${schema.minItems})`;
  if (schema.maxItems !== undefined) code += `.max(${schema.maxItems})`;
  if (schema.uniqueItems) {
    code +=
      ".refine((items) => new Set(items.map((item) => JSON.stringify(item))).size === items.length, { message: 'Items must be unique' })" +
      '.meta({ uniqueItems: true })';
  }
  return code;
};

const emitObject = (schema: SchemaObject, state: WalkState): string => {
  const { doc, mode } = state.ctx;
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(schema.properties ?? {}).filter(([, prop]) => !isHiddenInMode(doc, prop, mode));
  const additional = schema.additionalProperties;
  const additionalSchema =
    additional && typeof additional === 'object' && Object.keys(additional).length > 0 ? additional : undefined;

  if (entries.length === 0 && !schema.properties) {
    if (additional === false) return 'z.strictObject({})';
    const value = additionalSchema ? emitSchema(additionalSchema, child(state, `${state.location}{}`)) : 'z.unknown()';
    return `z.record(z.string(), ${value})`;
  }

  const lines = entries.map(([key, prop]) => {
    const hitsBefore = state.deferredHits.count;
    // Generate as if inside a getter; switch to a plain property when no deferred ref is used.
    let code = emitSchema(prop, {
      ...child(state, state.location ? `${state.location}.${key}` : key, { inGetter: true, indent: state.indent + 1 }),
      coerce: state.coerce,
    });
    const usesDeferred = state.deferredHits.count > hitsBefore;
    if (!required.has(key) && prop.default === undefined) code += '.optional()';
    return usesDeferred
      ? `${pad(state.indent + 1)}get ${propertyKey(key)}() {\n${pad(state.indent + 2)}return ${code};\n${pad(state.indent + 1)}},`
      : `${pad(state.indent + 1)}${propertyKey(key)}: ${code},`;
  });

  const factory = additional === false || (additional === undefined && state.ctx.strictObjects)
    ? 'z.strictObject'
    : additional === true || (additional && !additionalSchema)
      ? 'z.looseObject'
      : 'z.object';
  let code = `${factory}({\n${lines.join('\n')}\n${pad(state.indent)}})`;
  if (additionalSchema) code += `.catchall(${emitSchema(additionalSchema, child(state, `${state.location}{}`))})`;
  return code;
};

const emitComposition = (schema: SchemaObject, state: WalkState): string | undefined => {
  const { doc } = state.ctx;
  if (schema.allOf?.length) {
    const members = [...schema.allOf];
    // Sibling object keywords next to allOf behave like one more member.
    if (schema.properties) {
      members.push({ type: 'object', properties: schema.properties, ...(schema.required ? { required: schema.required } : {}) });
    }
    const codes = members.map((member, i) => emitSchema(member, child(state, `${state.location}<allOf ${i}>`)));
    return codes.slice(1).reduce((acc, next) => `${acc}.and(${next})`, codes[0] as string);
  }

  const variants = schema.oneOf ?? schema.anyOf;
  if (!variants?.length) return undefined;
  const nonNull = variants.filter((variant) => !isNullSchema(derefSchema(doc, variant)));
  const codes = nonNull.map((variant, i) => emitSchema(variant, child(state, `${state.location}<variant ${i}>`)));
  if (codes.length === 1) return codes[0];

  const discriminator = schema.discriminator?.propertyName;
  if (discriminator && canDiscriminate(doc, nonNull, discriminator)) {
    return `z.discriminatedUnion(${literal(discriminator)}, [${codes.join(', ')}])`;
  }
  return `z.union([${codes.join(', ')}])`;
};

/** z.discriminatedUnion needs plain object variants with a literal discriminator value. */
const canDiscriminate = (doc: OpenApiDocument, variants: SchemaObject[], key: string): boolean =>
  variants.every((variant) => {
    const resolved = derefSchema(doc, variant);
    if (resolved.allOf || resolved.oneOf || resolved.anyOf) return false;
    const prop = resolved.properties?.[key];
    if (!prop || !(resolved.required ?? []).includes(key)) return false;
    const propResolved = derefSchema(doc, prop);
    return propResolved.const !== undefined || (Array.isArray(propResolved.enum) && propResolved.enum.length > 0);
  });

const emitByType = (schema: SchemaObject, type: string | undefined, state: WalkState): string => {
  switch (type) {
    case 'string':
      if (schema.format === 'binary') return 'z.unknown() /* format: binary */';
      return emitString(schema);
    case 'number':
      return emitNumber(schema, false, state);
    case 'integer':
      return emitNumber(schema, true, state);
    case 'boolean':
      return state.coerce ? 'z.stringbool()' : 'z.boolean()';
    case 'array':
      return emitArray(schema, state);
    case 'object':
      return emitObject(schema, state);
    case 'null':
      return 'z.null()';
    default:
      return 'z.unknown()';
  }
};

const emitBase = (schema: SchemaObject, state: WalkState): string => {
  const composed = emitComposition(schema, state);
  if (composed !== undefined) return composed;
  if (Array.isArray(schema.enum)) return emitEnum(schema.enum);
  if (schema.const !== undefined) {
    if (schema.const !== null && typeof schema.const === 'object') {
      state.ctx.warnings.push(`${state.location}: object/array "const" is not supported, using z.unknown()`);
      return 'z.unknown()';
    }
    return `z.literal(${literal(schema.const)})`;
  }
  const types = nonNullTypes(schema);
  if (types.length > 1) {
    return `z.union([${types.map((type) => emitByType({ ...schema, type }, type, state)).join(', ')}])`;
  }
  return emitByType(schema, types[0] ?? inferType(schema), state);
};

/** Convert one OpenAPI schema object to a Zod v4 expression. */
export const emitSchema = (schema: SchemaObject, state: WalkState): string => {
  if (typeof schema.$ref === 'string') return emitRef(schema as SchemaObject & { $ref: string }, state);

  let code = emitBase(schema, state);
  const nullVariant = [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])].some((variant) =>
    isNullSchema(derefSchema(state.ctx.doc, variant)),
  );
  if ((isNullable(schema) || nullVariant) && !code.startsWith('z.null()')) code += '.nullable()';
  if (schema.default !== undefined) code += `.default(${literal(schema.default)})`;
  if (state.ctx.descriptions && schema.description) code += `.describe(${literal(schema.description)})`;

  const unsupported = UNSUPPORTED_KEYWORDS.filter((keyword) => schema[keyword] !== undefined);
  if (unsupported.length) {
    state.ctx.warnings.push(`${state.location || '<root>'}: unsupported keyword(s) ignored: ${unsupported.join(', ')}`);
    code += ` /* openapi-zod-sync: ignored ${unsupported.join(', ')} */`;
  }
  return code;
};

export interface SchemaToZodOptions {
  location?: string;
  indent?: number;
  coerce?: boolean;
}

/** Public entry point: emit Zod code for `schema` within `ctx`. */
export const schemaToZod = (schema: SchemaObject, ctx: ZodEmitContext, options: SchemaToZodOptions = {}): string =>
  emitSchema(schema, {
    ctx,
    location: options.location ?? '',
    indent: options.indent ?? 0,
    inGetter: false,
    coerce: options.coerce ?? false,
    deferredHits: { count: 0 },
    inlineDepth: 0,
  });
