import type { SchemaObject } from './types.js';

/** Decode one JSON Pointer token (RFC 6901). */
const decodeToken = (token: string): string =>
  decodeURIComponent(token).replace(/~1/g, '/').replace(/~0/g, '~');

/**
 * Resolve a local JSON reference ("#/components/schemas/Pet") against a root
 * document. Returns undefined when the pointer does not exist.
 */
export const resolvePointer = (root: unknown, ref: string): unknown => {
  if (ref === '#' || ref === '') return root;
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[decodeToken(raw)];
  }
  return current;
};

/** Follow $ref chains until a concrete schema is reached (cycle-safe). */
export const derefSchema = (root: unknown, schema: SchemaObject): SchemaObject => {
  let current = schema;
  const seen = new Set<string>();
  while (typeof current.$ref === 'string') {
    if (seen.has(current.$ref)) return {};
    seen.add(current.$ref);
    const next = resolvePointer(root, current.$ref);
    if (next === null || typeof next !== 'object') return {};
    current = next as SchemaObject;
  }
  return current;
};

/** Generic dereference for non-schema objects such as parameters or request bodies. */
export const derefObject = <T>(root: unknown, value: T): T => {
  let current: unknown = value;
  const seen = new Set<string>();
  while (current && typeof current === 'object' && typeof (current as { $ref?: unknown }).$ref === 'string') {
    const ref = (current as { $ref: string }).$ref;
    if (seen.has(ref)) break;
    seen.add(ref);
    current = resolvePointer(root, ref);
  }
  return current as T;
};

const COMPONENT_SCHEMA_PREFIX = '#/components/schemas/';

/** Return the component name when `ref` points to `#/components/schemas/<name>`. */
export const componentNameFromRef = (ref: string | undefined): string | undefined => {
  if (!ref || !ref.startsWith(COMPONENT_SCHEMA_PREFIX)) return undefined;
  const rest = ref.slice(COMPONENT_SCHEMA_PREFIX.length);
  return rest.includes('/') ? undefined : decodeToken(rest);
};

export const componentRef = (name: string): string =>
  COMPONENT_SCHEMA_PREFIX + name.replace(/~/g, '~0').replace(/\//g, '~1');
