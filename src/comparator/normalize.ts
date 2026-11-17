import { canonicalFormat } from '../core/formats.js';
import { resolvePointer } from '../core/refs.js';
import type { SchemaObject } from '../core/types.js';

/**
 * A schema node together with the document its `$ref`s resolve against.
 * OpenAPI nodes resolve against the OpenAPI document, Zod nodes against the
 * JSON Schema produced by `z.toJSONSchema()`.
 */
export interface SchemaRef {
  node: SchemaObject;
  root: unknown;
}

export type BaseType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';

export interface PropertyShape {
  schema: SchemaRef;
  required: boolean;
  readOnly: boolean;
  writeOnly: boolean;
  hasDefault: boolean;
}

/** Canonical, dialect-free view of a schema used by the diff. */
export interface Shape {
  /** Accepts any value (no type information). */
  any: boolean;
  types: Set<BaseType>;
  nullable: boolean;
  enumValues?: unknown[];
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems: boolean;
  properties?: Map<string, PropertyShape>;
  /** undefined = not specified, false = forbidden, SchemaRef = typed extra keys. */
  additional?: false | SchemaRef;
  items?: SchemaRef;
  /** Non-trivial unions that could not be collapsed into types/enums. */
  variants?: SchemaRef[];
  /** The resolved node identity, used for cycle detection. */
  identity: object;
}

const NUMERIC_KEYS = [
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'multipleOf',
  'minItems',
  'maxItems',
] as const;

const SAFE_MIN = Number.MIN_SAFE_INTEGER;
const SAFE_MAX = Number.MAX_SAFE_INTEGER;

/** Follow $ref chains. Returns the concrete node (or {} when unresolvable). */
export const resolveRef = (ref: SchemaRef): SchemaRef => {
  let node = ref.node;
  const seen = new Set<string>();
  while (node && typeof node.$ref === 'string') {
    if (seen.has(node.$ref)) return { node: {}, root: ref.root };
    seen.add(node.$ref);
    const next = resolvePointer(ref.root, node.$ref);
    node = next && typeof next === 'object' ? (next as SchemaObject) : {};
  }
  return { node: node ?? {}, root: ref.root };
};

const emptyShape = (identity: object): Shape => ({
  any: false,
  types: new Set(),
  nullable: false,
  uniqueItems: false,
  identity,
});

const valueType = (value: unknown): BaseType | 'null' | undefined => {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return undefined;
};

const normalizePattern = (pattern: string): string => {
  try {
    return new RegExp(pattern).source;
  } catch {
    return pattern;
  }
};

const isSimple = (shape: Shape): boolean =>
  !shape.properties && !shape.items && !shape.variants && shape.additional === undefined;

/** Merge allOf members: intersect types, union properties, keep the strictest bounds. */
const mergeShapes = (shapes: Shape[], identity: object): Shape => {
  const typed = shapes.filter((s) => !s.any);
  if (typed.length === 0) return { ...emptyShape(identity), any: true };
  const result = emptyShape(identity);
  result.nullable = typed.every((s) => s.nullable);
  const withTypes = typed.filter((s) => s.types.size > 0);
  if (withTypes.length) {
    result.types = new Set([...(withTypes[0] as Shape).types].filter((t) => withTypes.every((s) => s.types.has(t))));
  }
  for (const shape of typed) {
    if (shape.enumValues) {
      result.enumValues = result.enumValues
        ? result.enumValues.filter((v) => shape.enumValues?.some((w) => JSON.stringify(w) === JSON.stringify(v)))
        : shape.enumValues;
    }
    result.format ??= shape.format;
    result.pattern ??= shape.pattern;
    result.uniqueItems ||= shape.uniqueItems;
    const takeMax = (a: number | undefined, b: number | undefined): number | undefined =>
      a === undefined ? b : b === undefined ? a : Math.max(a, b);
    const takeMin = (a: number | undefined, b: number | undefined): number | undefined =>
      a === undefined ? b : b === undefined ? a : Math.min(a, b);
    result.minLength = takeMax(result.minLength, shape.minLength);
    result.minimum = takeMax(result.minimum, shape.minimum);
    result.exclusiveMinimum = takeMax(result.exclusiveMinimum, shape.exclusiveMinimum);
    result.minItems = takeMax(result.minItems, shape.minItems);
    result.maxLength = takeMin(result.maxLength, shape.maxLength);
    result.maximum = takeMin(result.maximum, shape.maximum);
    result.exclusiveMaximum = takeMin(result.exclusiveMaximum, shape.exclusiveMaximum);
    result.maxItems = takeMin(result.maxItems, shape.maxItems);
    result.multipleOf ??= shape.multipleOf;
    result.items ??= shape.items;
    if (shape.additional !== undefined) result.additional = shape.additional;
    if (shape.properties) {
      result.properties ??= new Map();
      for (const [key, prop] of shape.properties) {
        const existing = result.properties.get(key);
        result.properties.set(
          key,
          existing
            ? {
                // Same property in several members: the value must satisfy all of them.
                schema: { node: { allOf: [existing.schema.node, prop.schema.node] }, root: prop.schema.root },
                required: existing.required || prop.required,
                readOnly: existing.readOnly || prop.readOnly,
                writeOnly: existing.writeOnly || prop.writeOnly,
                hasDefault: existing.hasDefault || prop.hasDefault,
              }
            : prop,
        );
      }
    }
    if (shape.variants) result.variants = shape.variants;
  }
  if (result.types.size === 0 && result.properties) result.types.add('object');
  return result;
};

const shapeCache = new WeakMap<object, Shape>();

/** Normalize one schema node (OpenAPI 3.0/3.1 or Zod JSON Schema) into a Shape. */
export const normalize = (input: SchemaRef): Shape => {
  const { node, root } = resolveRef(input);
  const cached = shapeCache.get(node);
  if (cached) return cached;
  const shape = buildShape(node, root);
  shapeCache.set(node, shape);
  return shape;
};

const buildShape = (node: SchemaObject, root: unknown): Shape => {
  // allOf: normalize siblings + members and merge.
  if (Array.isArray(node.allOf) && node.allOf.length) {
    const { allOf, ...rest } = node;
    const members = allOf.map((member) => normalize({ node: member, root }));
    const hasSiblings = Object.keys(rest).some((key) => !['description', 'title', 'default', 'example'].includes(key));
    if (hasSiblings) members.push(buildShape(rest, root));
    return mergeShapes(members, node);
  }

  const shape = emptyShape(node);

  // oneOf / anyOf: strip null variants, collapse simple variants into types/enums.
  const unionVariants = node.oneOf ?? node.anyOf;
  if (Array.isArray(unionVariants) && unionVariants.length) {
    const normalized = unionVariants.map((variant) => ({ ref: { node: variant, root }, shape: normalize({ node: variant, root }) }));
    const nonNull = normalized.filter(({ shape: s }) => !(s.nullable && s.types.size === 0 && !s.any && !s.enumValues));
    const nullable = nonNull.length !== normalized.length || normalized.some(({ shape: s }) => s.nullable);
    if (normalized.some(({ shape: s }) => s.any)) return { ...shape, any: true };
    if (nonNull.length === 1) {
      const single = nonNull[0]?.shape as Shape;
      return { ...single, nullable: single.nullable || nullable, identity: node };
    }
    const simple = nonNull.every(({ shape: s }) => isSimple(s));
    const allEnums = simple && nonNull.every(({ shape: s }) => s.enumValues);
    if (allEnums) {
      shape.enumValues = nonNull.flatMap(({ shape: s }) => s.enumValues ?? []);
      nonNull.forEach(({ shape: s }) => s.types.forEach((t) => shape.types.add(t)));
    } else if (simple && nonNull.every(({ shape: s }) => !s.enumValues && !hasConstraints(s))) {
      nonNull.forEach(({ shape: s }) => s.types.forEach((t) => shape.types.add(t)));
    } else {
      shape.variants = nonNull.map(({ ref }) => ref);
    }
    shape.nullable = nullable;
    finalizeTypes(shape);
    return shape;
  }

  // Types (3.1 arrays, 3.0 nullable).
  const declared = Array.isArray(node.type) ? node.type : typeof node.type === 'string' ? [node.type] : [];
  for (const type of declared) {
    if (type === 'null') shape.nullable = true;
    else shape.types.add(type as BaseType);
  }
  if (node.nullable === true) shape.nullable = true;

  // Enum / const.
  const values = Array.isArray(node.enum) ? node.enum : node.const !== undefined ? [node.const] : undefined;
  if (values) {
    if (values.includes(null)) shape.nullable = true;
    const present = values.filter((v) => v !== null);
    if (present.length) shape.enumValues = present;
    if (shape.types.size === 0) {
      present.forEach((v) => {
        const t = valueType(v);
        if (t && t !== 'null') shape.types.add(t === 'integer' ? 'number' : t);
      });
    }
    if (present.length === 0 && shape.types.size === 0) return shape; // pure null
  }

  // Constraints.
  for (const key of NUMERIC_KEYS) {
    const value = node[key];
    if (typeof value === 'number') shape[key] = value;
  }
  if (typeof node.exclusiveMinimum === 'number') shape.exclusiveMinimum = node.exclusiveMinimum;
  if (typeof node.exclusiveMaximum === 'number') shape.exclusiveMaximum = node.exclusiveMaximum;
  // OpenAPI 3.0 boolean exclusive flags.
  if (node.exclusiveMinimum === true && shape.minimum !== undefined) {
    shape.exclusiveMinimum = shape.minimum;
    delete shape.minimum;
  }
  if (node.exclusiveMaximum === true && shape.maximum !== undefined) {
    shape.exclusiveMaximum = shape.maximum;
    delete shape.maximum;
  }
  // Zod adds safe-integer bounds to z.int(); they carry no contract meaning.
  if (shape.minimum === SAFE_MIN) delete shape.minimum;
  if (shape.maximum === SAFE_MAX) delete shape.maximum;
  if (shape.minLength === 0) delete shape.minLength;
  if (shape.minItems === 0) delete shape.minItems;
  if (typeof node.format === 'string') shape.format = canonicalFormat(node.format);
  if (typeof node.pattern === 'string') shape.pattern = normalizePattern(node.pattern);
  shape.uniqueItems = node.uniqueItems === true;

  // Arrays.
  if (node.items && typeof node.items === 'object') shape.items = { node: node.items, root };

  // Objects.
  if (node.properties && typeof node.properties === 'object') {
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    shape.properties = new Map();
    for (const [key, prop] of Object.entries(node.properties)) {
      const resolved = resolveRef({ node: prop, root }).node;
      shape.properties.set(key, {
        schema: { node: prop, root },
        required: required.has(key),
        readOnly: prop.readOnly === true || resolved.readOnly === true,
        writeOnly: prop.writeOnly === true || resolved.writeOnly === true,
        hasDefault: prop.default !== undefined || resolved.default !== undefined,
      });
    }
  }
  const additional = node.additionalProperties;
  if (additional === false) shape.additional = false;
  else if (additional && typeof additional === 'object') shape.additional = { node: additional, root };
  else if (additional === true) shape.additional = { node: {}, root };

  finalizeTypes(shape);
  if (shape.types.size === 0) {
    // Infer from keywords, otherwise the node accepts anything.
    if (shape.properties || shape.additional !== undefined) shape.types.add('object');
    else if (shape.items) shape.types.add('array');
    else if (!shape.enumValues) shape.any = !shape.nullable || declared.length === 0;
  }
  return shape;
};

/** `number` subsumes `integer` when both are present. */
const finalizeTypes = (shape: Shape): void => {
  if (shape.types.has('number') && shape.types.has('integer')) shape.types.delete('integer');
};

const hasConstraints = (shape: Shape): boolean =>
  NUMERIC_KEYS.some((key) => shape[key] !== undefined) ||
  shape.exclusiveMinimum !== undefined ||
  shape.exclusiveMaximum !== undefined ||
  shape.format !== undefined ||
  shape.pattern !== undefined ||
  shape.uniqueItems;
