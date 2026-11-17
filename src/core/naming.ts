import type { OperationPart } from './types.js';

const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
  'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package', 'private', 'protected',
  'public', 'await', 'z', 'operations',
  // Globals and TS utility types that a generated export must not shadow.
  'Error', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Map', 'Set', 'Promise', 'Symbol',
  'JSON', 'Math', 'RegExp', 'Function', 'BigInt', 'Infinity', 'NaN', 'Record', 'Partial', 'Required',
  'Readonly', 'Pick', 'Omit', 'Exclude', 'Extract', 'Awaited', 'URL', 'Blob', 'File', 'Response', 'Request',
]);

const splitWords = (value: string): string[] =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

/** "create-user_v2" → "CreateUserV2". Always a valid identifier. */
export const pascalCase = (value: string): string => {
  const result = splitWords(value)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
  if (!result) return 'Schema';
  const safe = /^[0-9]/.test(result) ? `_${result}` : result;
  return RESERVED.has(safe) ? `${safe}Schema` : safe;
};

export const camelCase = (value: string): string => {
  const pascal = pascalCase(value);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
};

/** Derive an operationId from method + path: GET /users/{id} → getUsersById. */
export const syntheticOperationId = (method: string, path: string): string => {
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const param = /^\{(.+)\}$/.exec(segment);
      return param ? `by ${param[1]}` : segment;
    });
  return camelCase([method, ...segments].join(' '));
};

const PART_SUFFIX: Record<Exclude<OperationPart['kind'], 'response'>, string> = {
  params: 'Params',
  query: 'Query',
  headers: 'Headers',
  body: 'Body',
};

/**
 * Conventional export name for an operation part. The generator emits these
 * names and the validator uses them to match user-written schemas.
 *   createPet + body          → CreatePetBody
 *   createPet + response.201  → CreatePetResponse201
 */
export const partExportName = (operationId: string, part: Pick<OperationPart, 'kind' | 'status'>): string => {
  const base = pascalCase(operationId);
  if (part.kind === 'response') {
    const status = part.status ?? 'default';
    return `${base}Response${status === 'default' ? 'Default' : status.toUpperCase()}`;
  }
  return `${base}${PART_SUFFIX[part.kind]}`;
};

export const componentExportName = (name: string): string => pascalCase(name);

/** Quote an object key when it is not a valid identifier. */
export const propertyKey = (key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
