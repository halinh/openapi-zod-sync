import { basename, resolve } from 'node:path';
import { componentExportName, partExportName } from '../core/naming.js';
import type { OperationInfo, OperationPart } from '../core/types.js';
import { readMeta } from './loadSchemas.js';
import type { ZodExport } from './loadSchemas.js';

export type MatchVia = 'mapping' | 'meta' | 'convention';

export interface SchemaMatch {
  export: ZodExport;
  via: MatchVia;
}

/**
 * Explicit mapping from a target to an export.
 * Keys: "createPet.body", "createPet.response.201" or "#/components/schemas/Pet".
 * Values: "ExportName" or "path/to/file.ts#ExportName".
 */
export type SchemaMapping = Record<string, string>;

export const operationTargetKey = (op: OperationInfo, part: OperationPart): string => `${op.operationId}.${part.key}`;
export const componentTargetKey = (name: string): string => `#/components/schemas/${name}`;

export const createMatcher = (input: ZodExport[], mapping: SchemaMapping = {}, cwd: string = process.cwd()) => {
  // Exports may be provided programmatically without pre-read metadata.
  const exports = input.map((e) => {
    if (e.meta) return e;
    const meta = readMeta(e.schema);
    return meta ? { ...e, meta } : e;
  });
  const byName = new Map<string, ZodExport[]>();
  for (const e of exports) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
  const used = new Set<ZodExport>();
  /** Mapping entries that could not be resolved, keyed by target. Reported instead of thrown. */
  const mappingErrors = new Map<string, string>();

  const fromMapping = (key: string): ZodExport | undefined => {
    const value = mapping[key];
    if (!value) return undefined;
    const hash = value.lastIndexOf('#');
    if (hash > 0) {
      const file = resolve(cwd, value.slice(0, hash));
      const name = value.slice(hash + 1);
      const found = exports.find((e) => e.name === name && (e.file === file || basename(e.file) === basename(file)));
      if (!found) mappingErrors.set(key, `mapped export "${value}" was not found in the loaded files`);
      return found;
    }
    const candidates = byName.get(value) ?? [];
    if (candidates.length === 0) mappingErrors.set(key, `mapped export "${value}" was not found in the loaded files`);
    if (candidates.length > 1) {
      mappingErrors.set(key, `mapped export "${value}" is ambiguous (${candidates.length} files); use "file.ts#${value}"`);
      return undefined;
    }
    return candidates[0];
  };

  const byConvention = (names: string[]): ZodExport | undefined => {
    for (const name of names) {
      const found = byName.get(name)?.[0];
      if (found) return found;
    }
    return undefined;
  };

  const take = (found: ZodExport | undefined, via: MatchVia): SchemaMatch | undefined => {
    if (!found) return undefined;
    used.add(found);
    return { export: found, via };
  };

  const matchPart = (op: OperationInfo, part: OperationPart): SchemaMatch | undefined => {
    const key = operationTargetKey(op, part);
    const conventional = partExportName(op.operationId, part);
    return (
      take(fromMapping(key), 'mapping') ??
      take(
        exports.find((e) => e.meta?.operationId === op.operationId && e.meta?.part === part.key),
        'meta',
      ) ??
      take(byConvention([conventional, `${conventional}Schema`]), 'convention')
    );
  };

  /** Match a component; `input` selects the request (readOnly-stripped) variant. */
  const matchComponent = (name: string, variant: 'default' | 'input'): SchemaMatch | undefined => {
    const base = componentExportName(name);
    const key = componentTargetKey(name) + (variant === 'input' ? ':input' : '');
    const names = variant === 'input' ? [`${base}Input`, `${base}InputSchema`] : [base, `${base}Schema`];
    return (
      take(fromMapping(key), 'mapping') ??
      take(
        exports.find(
          (e) => e.meta?.component === name && (variant === 'input' ? e.meta.variant === 'input' : e.meta.variant === undefined),
        ),
        'meta',
      ) ??
      take(byConvention(names), 'convention')
    );
  };

  /** Exports that did not match anything (reported as info). */
  const unmatched = (): ZodExport[] => exports.filter((e) => !used.has(e));

  const mappingError = (key: string): string | undefined => mappingErrors.get(key);

  return { matchPart, matchComponent, unmatched, mappingError };
};
