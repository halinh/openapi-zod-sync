import { relative } from 'node:path';
import { compare, zodToJsonSchema } from '../comparator/index.js';
import { diffSchemas } from '../comparator/diff.js';
import { loadSpec } from '../core/load.js';
import type { LoadSpecOptions } from '../core/load.js';
import { partExportName } from '../core/naming.js';
import { listOperations } from '../core/operations.js';
import { componentNameFromRef, componentRef, resolvePointer } from '../core/refs.js';
import { selectOperations } from '../core/select.js';
import type {
  Issue,
  IssueCode,
  LoadedSpec,
  OpenApiDocument,
  OperationInfo,
  OperationPart,
  OperationSelector,
  SchemaMode,
  SchemaObject,
  Severity,
} from '../core/types.js';
import { VERSION } from '../version.js';
import { loadZodExports } from './loadSchemas.js';
import type { ZodExport } from './loadSchemas.js';
import { componentTargetKey, createMatcher, operationTargetKey } from './match.js';
import type { MatchVia, SchemaMapping } from './match.js';

export interface CheckOptions extends LoadSpecOptions {
  /** Files or globs of modules exporting Zod schemas. */
  schemas: string[];
  /** Restrict the check to some operations (default: all). */
  select?: OperationSelector;
  /** Explicit target → export mapping (see SchemaMapping). */
  mapping?: SchemaMapping;
  /** Report operation parts without a matching schema (default: true). */
  reportMissing?: boolean;
  /** Severity for MISSING_SCHEMA (default: 'warning'). */
  missingSeverity?: Severity;
  /** Override or silence ('off') individual issue codes. */
  severity?: Partial<Record<IssueCode, Severity | 'off'>>;
  /** Also compare component schemas matched by name/meta/mapping (default: true). */
  components?: boolean;
  cwd?: string;
  /** Pre-loaded exports (skips runtime import; useful in tests and programmatic use). */
  exports?: ZodExport[];
}

export type TargetStatus = 'ok' | 'drift' | 'missing' | 'covered';

export interface CheckTargetResult {
  /** "createPet.body", "createPet.response.201" or "#/components/schemas/Pet". */
  target: string;
  kind: 'operation' | 'component';
  operationId?: string;
  method?: string;
  path?: string;
  part?: string;
  component?: string;
  status: TargetStatus;
  match?: { export: string; file: string; via: MatchVia };
  /** For "covered" targets: the component export that validates this part. */
  coveredBy?: string;
  issues: Issue[];
}

export interface CheckSummary {
  targets: number;
  ok: number;
  drift: number;
  missing: number;
  covered: number;
  errors: number;
  warnings: number;
  infos: number;
}

export interface CheckReport {
  tool: 'openapi-zod-sync';
  version: string;
  spec: { title: string; version: string; openapi: string; source?: string };
  summary: CheckSummary;
  results: CheckTargetResult[];
  unmatchedExports: { name: string; file: string }[];
}

const partMode = (part: OperationPart): SchemaMode => (part.kind === 'response' ? 'response' : 'request');
// Request bodies are compared with what clients may send (Zod input), everything else with parsed output.
const partIo = (part: OperationPart): 'input' | 'output' => (part.kind === 'body' ? 'input' : 'output');

/** Lower-case top-level property names so header schemas compare case-insensitively. */
const lowerCaseProperties = (schema: SchemaObject): SchemaObject => {
  if (!schema.properties) return schema;
  return {
    ...schema,
    properties: Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k.toLowerCase(), v])),
    ...(schema.required ? { required: schema.required.map((r) => r.toLowerCase()) } : {}),
  };
};

/** Components reachable (transitively) from a set of schemas. */
const reachableComponents = (doc: OpenApiDocument, roots: SchemaObject[]): Set<string> => {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    const name = componentNameFromRef((value as SchemaObject).$ref);
    if (name !== undefined) {
      if (found.has(name)) return;
      found.add(name);
      visit(resolvePointer(doc, componentRef(name)));
      return;
    }
    Object.values(value).forEach(visit);
  };
  roots.forEach(visit);
  return found;
};

const applySeverity = (issues: Issue[], overrides: CheckOptions['severity']): Issue[] => {
  if (!overrides) return issues;
  return issues.flatMap((issue) => {
    const override = overrides[issue.code];
    if (override === 'off') return [];
    return override ? [{ ...issue, severity: override }] : [issue];
  });
};

const statusOf = (issues: Issue[]): TargetStatus =>
  issues.some((i) => i.severity === 'error' || i.severity === 'warning') ? 'drift' : 'ok';

const summarize = (results: CheckTargetResult[]): CheckSummary => {
  const issues = results.flatMap((r) => r.issues);
  return {
    targets: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    drift: results.filter((r) => r.status === 'drift').length,
    missing: results.filter((r) => r.status === 'missing').length,
    covered: results.filter((r) => r.status === 'covered').length,
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    infos: issues.filter((i) => i.severity === 'info').length,
  };
};

const comparePart = (spec: LoadedSpec, part: OperationPart, zodExport: ZodExport): Issue[] => {
  const mode = partMode(part);
  if (part.kind !== 'headers') return compare(zodExport.schema, part.schema, { document: spec.document, mode, io: partIo(part) });
  // Headers: normalise both sides to lower-case keys.
  const actual = lowerCaseProperties(zodToJsonSchema(zodExport.schema, 'output'));
  return diffSchemas({ node: part.schema, root: spec.document }, { node: actual, root: actual }, { mode });
};

/**
 * Check existing Zod schemas against an OpenAPI document and report drift.
 * Pure with respect to the spec: nothing is written to disk.
 */
export const check = async (input: string | OpenApiDocument | LoadedSpec, options: CheckOptions): Promise<CheckReport> => {
  const cwd = options.cwd ?? process.cwd();
  const spec =
    typeof input === 'object' && 'document' in input && 'version' in input
      ? (input as LoadedSpec)
      : await loadSpec(input as string | OpenApiDocument, options);
  const exports = options.exports ?? (await loadZodExports(options.schemas, { cwd }));
  const matcher = createMatcher(exports, options.mapping, cwd);
  const { reportMissing = true, missingSeverity = 'warning', components = true } = options;
  const display = (file: string): string => relative(cwd, file) || file;

  const operations: OperationInfo[] = selectOperations(listOperations(spec.document), options.select);
  const results: CheckTargetResult[] = [];

  // 1. Components (matched by mapping / meta / naming convention).
  const componentMatches = new Map<string, string>();
  if (components) {
    const allSchemas = Object.keys(spec.document.components?.schemas ?? {});
    const hasFilter = Boolean(
      options.select && !options.select.all &&
        (options.select.operationIds?.length || options.select.tags?.length || options.select.paths?.length || options.select.methods?.length),
    );
    const inScope = hasFilter
      ? reachableComponents(spec.document, operations.flatMap((op) => op.parts.map((p) => p.schema)))
      : new Set(allSchemas);
    for (const name of allSchemas.filter((n) => inScope.has(n))) {
      const schema = resolvePointer(spec.document, componentRef(name)) as SchemaObject;
      for (const variant of ['default', 'input'] as const) {
        const match = matcher.matchComponent(name, variant);
        if (!match) continue;
        if (variant === 'default') componentMatches.set(name, match.export.name);
        const mode: SchemaMode = variant === 'input' ? 'request' : 'component';
        const issues = applySeverity(
          compare(match.export.schema, schema, { document: spec.document, mode, io: variant === 'input' ? 'input' : 'output' }),
          options.severity,
        );
        results.push({
          target: componentTargetKey(name) + (variant === 'input' ? ' (input)' : ''),
          kind: 'component',
          component: name,
          status: statusOf(issues),
          match: { export: match.export.name, file: display(match.export.file), via: match.via },
          issues,
        });
      }
    }
  }

  // 2. Operation parts.
  for (const op of operations) {
    for (const part of op.parts) {
      const base = {
        target: operationTargetKey(op, part),
        kind: 'operation' as const,
        operationId: op.operationId,
        method: op.method.toUpperCase(),
        path: op.path,
        part: part.key,
      };
      const match = matcher.matchPart(op, part);
      if (match) {
        const issues = applySeverity(comparePart(spec, part, match.export), options.severity);
        results.push({
          ...base,
          status: statusOf(issues),
          match: { export: match.export.name, file: display(match.export.file), via: match.via },
          issues,
        });
        continue;
      }
      // A part that is a plain $ref to a checked component is covered by that check.
      const refName = componentNameFromRef(part.schema.$ref);
      const coveredBy = refName !== undefined ? componentMatches.get(refName) : undefined;
      if (coveredBy) {
        results.push({ ...base, status: 'covered', coveredBy, issues: [] });
        continue;
      }
      const mappingError = matcher.mappingError(base.target);
      if (!reportMissing && !mappingError) continue;
      const issues = applySeverity(
        [
          {
            code: 'MISSING_SCHEMA',
            severity: missingSeverity,
            path: '',
            message: `No Zod schema found for ${op.method.toUpperCase()} ${op.path} (${part.key})${mappingError ? `: ${mappingError}` : ''}.`,
            suggestion: `Export a schema named "${partExportName(op.operationId, part)}", add .meta({ openapi: { operationId: "${op.operationId}", part: "${part.key}" } }), or map "${base.target}" in the config. Or run: openapi-zod-sync generate --operation ${op.operationId}`,
          },
        ],
        options.severity,
      );
      results.push({ ...base, status: 'missing', issues });
    }
  }

  return {
    tool: 'openapi-zod-sync',
    version: VERSION,
    spec: {
      title: spec.document.info.title,
      version: spec.document.info.version,
      openapi: spec.document.openapi,
      ...(spec.source ? { source: spec.source } : {}),
    },
    summary: summarize(results),
    results,
    unmatchedExports: matcher.unmatched().map((e) => ({ name: e.name, file: display(e.file) })),
  };
};

export type FailOn = 'error' | 'warning' | 'never';

/** True when the report should fail a CI run for the given threshold. */
export const shouldFail = (report: CheckReport, failOn: FailOn = 'error'): boolean => {
  if (failOn === 'never') return false;
  if (failOn === 'warning') return report.summary.errors + report.summary.warnings > 0;
  return report.summary.errors > 0;
};
