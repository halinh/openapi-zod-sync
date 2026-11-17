import { camelCase, componentExportName, partExportName, propertyKey } from '../core/naming.js';
import { listOperations } from '../core/operations.js';
import { componentNameFromRef, componentRef, resolvePointer } from '../core/refs.js';
import { selectOperations } from '../core/select.js';
import type {
  LoadedSpec,
  OperationInfo,
  OperationPart,
  OperationSelector,
  SchemaMode,
  SchemaObject,
} from '../core/types.js';
import { VERSION } from '../version.js';
import { schemaToZod } from './schemaToZod.js';
import type { RefTarget, ZodEmitContext } from './schemaToZod.js';

export interface GenerateOptions {
  /** Which operations to generate (default: all). */
  select?: OperationSelector;
  /** Emit `z.strictObject` when `additionalProperties` is not specified (default: false). */
  strictObjects?: boolean;
  /** Coerce path/query/header primitives from strings (default: true). */
  coerceParams?: boolean;
  /** Emit TypeScript output: `export type X = z.infer<typeof X>` (default: true). */
  typescript?: boolean;
  /** Attach `.meta({ openapi: { operationId, part } })` so `check` can match by metadata (default: false). */
  register?: boolean;
  /** Keep OpenAPI descriptions as `.describe()` (default: true). */
  descriptions?: boolean;
  /** Emit an `operations` map with method, path and schemas per operation (default: true). */
  operationsMap?: boolean;
  /** One file, or one file per tag plus `components` and `index` (default: 'none'). */
  splitBy?: 'none' | 'tag';
  /** Extension used in relative imports when splitting (default: '.js'). */
  importExtension?: string;
}

export interface GeneratedFile {
  /** File name relative to the output directory (single-file mode: "schemas.ts"). */
  path: string;
  content: string;
}

export interface GeneratedExport {
  name: string;
  kind: 'component' | 'part';
  component?: string;
  operationId?: string;
  part?: string;
  file: string;
}

export interface GenerateResult {
  files: GeneratedFile[];
  operations: OperationInfo[];
  exports: GeneratedExport[];
  warnings: string[];
}

type Variant = 'read' | 'write';
const variantMode = (variant: Variant): SchemaMode => (variant === 'write' ? 'request' : 'response');
const partMode = (part: OperationPart): SchemaMode => (part.kind === 'response' ? 'response' : 'request');
const isParamPart = (part: OperationPart): boolean =>
  part.kind === 'params' || part.kind === 'query' || part.kind === 'headers';

/** Visit every sub-schema (not following $refs). */
const forEachSubschema = (schema: SchemaObject, visit: (sub: SchemaObject) => void): void => {
  const recurse = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const s = value as SchemaObject;
    visit(s);
    if (s.$ref) return;
    Object.values(s.properties ?? {}).forEach(recurse);
    if (s.items) recurse(s.items);
    if (s.additionalProperties && typeof s.additionalProperties === 'object') recurse(s.additionalProperties);
    [...(s.allOf ?? []), ...(s.oneOf ?? []), ...(s.anyOf ?? [])].forEach(recurse);
  };
  recurse(schema);
};

interface ComponentKey {
  name: string;
  variant: Variant;
}
const keyOf = (k: ComponentKey): string => `${k.variant}:${k.name}`;

/** Emitter state shared by single-file and split modes. */
const createPlanner = (spec: LoadedSpec) => {
  const doc = spec.document;
  const componentSchema = (name: string): SchemaObject =>
    (resolvePointer(doc, componentRef(name)) as SchemaObject | undefined) ?? {};

  // A component needs read/write variants when it (transitively) has readOnly/writeOnly properties.
  const variantCache = new Map<string, boolean>();
  const needsVariants = (name: string, stack: Set<string> = new Set()): boolean => {
    const cached = variantCache.get(name);
    if (cached !== undefined) return cached;
    if (stack.has(name)) return false;
    stack.add(name);
    let found = false;
    forEachSubschema(componentSchema(name), (sub) => {
      if (found) return;
      if (Object.values(sub.properties ?? {}).some((p) => p.readOnly || p.writeOnly)) found = true;
      const ref = componentNameFromRef(sub.$ref);
      if (ref !== undefined && needsVariants(ref, stack)) found = true;
    });
    stack.delete(name);
    variantCache.set(name, found);
    return found;
  };

  const variantFor = (name: string, mode: SchemaMode): Variant =>
    needsVariants(name) && mode === 'request' ? 'write' : 'read';

  // Collect components reachable from the selected parts, with dependency edges.
  const deps = new Map<string, ComponentKey[]>();
  const keys = new Map<string, ComponentKey>();
  const collect = (schema: SchemaObject, mode: SchemaMode, into: ComponentKey[]): void => {
    forEachSubschema(schema, (sub) => {
      const name = componentNameFromRef(sub.$ref);
      if (name === undefined) return;
      const key: ComponentKey = { name, variant: variantFor(name, mode) };
      into.push(key);
      if (keys.has(keyOf(key))) return;
      keys.set(keyOf(key), key);
      const own: ComponentKey[] = [];
      deps.set(keyOf(key), own);
      collect(componentSchema(name), variantMode(key.variant), own);
    });
  };

  // Topological order (dependencies first); cycles are broken by DFS order.
  const order = (): ComponentKey[] => {
    const result: ComponentKey[] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (key: ComponentKey): void => {
      const id = keyOf(key);
      if (state.has(id)) return;
      state.set(id, 'visiting');
      for (const dep of deps.get(id) ?? []) visit(dep);
      state.set(id, 'done');
      result.push(key);
    };
    [...keys.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b))).forEach(visit);
    return result;
  };

  return { doc, componentSchema, needsVariants, variantFor, collect, order };
};

/** Allocates unique identifiers. */
const createNamer = () => {
  const used = new Set<string>();
  return (preferred: string): string => {
    let name = preferred;
    for (let i = 2; used.has(name); i++) name = `${preferred}${i}`;
    used.add(name);
    return name;
  };
};

/**
 * Make untrusted spec text safe inside a `//` or `/* *\/` comment: line
 * terminators would end a line comment, and `*\/` would end a block comment.
 */
const commentText = (value: unknown): string =>
  String(value)
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/\*\//g, '*\\/');

const header = (spec: LoadedSpec): string =>
  [
    `// Generated by openapi-zod-sync v${VERSION} from "${commentText(spec.document.info.title)}" (${commentText(spec.document.info.version)}).`,
    '// Do not edit by hand: re-run `openapi-zod-sync generate` instead.',
  ].join('\n');

const jsdoc = (lines: string[]): string =>
  lines.length ? `/**\n${lines.map((l) => ` * ${commentText(l)}`).join('\n')}\n */\n` : '';

interface Section {
  /** File this section belongs to (split mode), e.g. "components" or "pets". */
  file: string;
  code: string;
  defines: string[];
  references: string[];
}

/**
 * Generate Zod schema source code for the selected operations of a loaded spec.
 * Pure function: no file system access (see `generate()` for that).
 */
export const generateFromSpec = (spec: LoadedSpec, options: GenerateOptions = {}): GenerateResult => {
  const {
    select,
    strictObjects = false,
    coerceParams = true,
    typescript = true,
    register = false,
    descriptions = true,
    operationsMap = true,
    splitBy = 'none',
    importExtension = '.js',
  } = options;

  const operations = selectOperations(listOperations(spec.document), select);
  const planner = createPlanner(spec);
  const warnings: string[] = [];
  const exports: GeneratedExport[] = [];
  const allocate = createNamer();

  for (const op of operations) {
    for (const part of op.parts) planner.collect(part.schema, partMode(part), []);
  }
  const componentOrder = planner.order();

  // Allocate component identifiers first so they get the cleanest names.
  const identifiers = new Map<string, string>();
  for (const key of componentOrder) {
    const base = componentExportName(key.name) + (key.variant === 'write' ? 'Input' : '');
    identifiers.set(keyOf(key), allocate(base));
  }

  const emitted = new Set<string>();
  const sections: Section[] = [];
  let currentRefs: string[] = [];

  const makeContext = (mode: SchemaMode): ZodEmitContext => ({
    doc: spec.document,
    version: spec.version,
    mode,
    strictObjects,
    descriptions,
    warnings,
    ref: (name: string, refMode: SchemaMode): RefTarget => {
      const key = keyOf({ name, variant: planner.variantFor(name, refMode) });
      const identifier = identifiers.get(key) ?? componentExportName(name);
      currentRefs.push(identifier);
      return { identifier, deferred: !emitted.has(key) };
    },
  });

  const typeLine = (name: string): string =>
    typescript ? `\nexport type ${name} = z.infer<typeof ${name}>;` : '';

  for (const key of componentOrder) {
    const id = keyOf(key);
    const name = identifiers.get(id) as string;
    const mode = variantMode(key.variant);
    currentRefs = [];
    const schema = planner.componentSchema(key.name);
    let code = schemaToZod(schema, makeContext(mode), { location: `#/components/schemas/${key.name}` });
    if (register) {
      code += `.meta({ openapi: { component: ${JSON.stringify(key.name)}${key.variant === 'write' ? ", variant: 'input'" : ''} } })`;
    }
    emitted.add(id);
    const doc = jsdoc([
      ...(schema.description ? [schema.description] : []),
      `@see #/components/schemas/${key.name}${key.variant === 'write' ? ' (request variant: readOnly properties removed)' : ''}`,
    ]);
    sections.push({
      file: 'components',
      code: `${doc}export const ${name} = ${code};${typeLine(name)}`,
      defines: [name],
      references: currentRefs.filter((r) => r !== name),
    });
    exports.push({ name, kind: 'component', component: key.name, file: 'components' });
  }

  interface OpEntry {
    op: OperationInfo;
    file: string;
    parts: { part: OperationPart; name: string }[];
  }
  const opEntries: OpEntry[] = [];

  for (const op of operations) {
    const file = camelCase(op.tags[0] ?? 'default');
    const entry: OpEntry = { op, file, parts: [] };
    const blocks: string[] = [];
    currentRefs = [];
    for (const part of op.parts) {
      const name = allocate(partExportName(op.operationId, part));
      const mode = partMode(part);
      let code = schemaToZod(part.schema, makeContext(mode), {
        location: `${op.operationId}.${part.key}`,
        coerce: coerceParams && isParamPart(part),
      });
      if (register) code += `.meta({ openapi: { operationId: ${JSON.stringify(op.operationId)}, part: ${JSON.stringify(part.key)} } })`;
      const description =
        part.kind === 'response' ? `Response ${part.status}${part.mediaType ? ` (${part.mediaType})` : ''}` : `Request ${part.kind}`;
      blocks.push(`/** ${commentText(description)} */\nexport const ${name} = ${code};${typeLine(name)}`);
      entry.parts.push({ part, name });
      exports.push({ name, kind: 'part', operationId: op.operationId, part: part.key, file });
    }
    opEntries.push(entry);
    if (blocks.length === 0) continue;
    const title = jsdoc([
      `${op.method.toUpperCase()} ${op.path}${op.summary ? ` — ${op.summary}` : ''}`,
      `operationId: ${op.operationId}${op.syntheticId ? ' (derived, not defined in spec)' : ''}`,
      ...(op.deprecated ? ['@deprecated'] : []),
    ]);
    sections.push({
      file,
      code: `// ---------------------------------------------------------------------------\n${title}${blocks.join('\n\n')}`,
      defines: entry.parts.map((p) => p.name),
      references: [...new Set(currentRefs)],
    });
  }

  const operationsCode = (): string => {
    const lines = opEntries.map(({ op, parts }) => {
      const fields = [`method: ${JSON.stringify(op.method)}`, `path: ${JSON.stringify(op.path)}`];
      for (const kind of ['params', 'query', 'headers', 'body'] as const) {
        const found = parts.find((p) => p.part.kind === kind);
        if (found) fields.push(`${kind}: ${found.name}`);
      }
      const responses = parts.filter((p) => p.part.kind === 'response');
      fields.push(`responses: { ${responses.map((r) => `${JSON.stringify(r.part.status)}: ${r.name}`).join(', ')} }`);
      return `  ${propertyKey(op.operationId)}: {\n${fields.map((f) => `    ${f},`).join('\n')}\n  },`;
    });
    return `/** Index of generated operations: method, path and schemas per operationId. */\nexport const operations = {\n${lines.join('\n')}\n}${typescript ? ' as const' : ''};`;
  };

  const files: GeneratedFile[] = [];
  const ext = typescript ? '.ts' : '.js';
  const zodImport = "import { z } from 'zod';";

  if (splitBy === 'none') {
    const body = sections.map((s) => s.code);
    if (operationsMap && opEntries.length) body.push(operationsCode());
    files.push({ path: `schemas${ext}`, content: `${header(spec)}\n${zodImport}\n\n${body.join('\n\n')}\n` });
  } else {
    // Map every identifier to the file that defines it, then emit imports per file.
    const owner = new Map<string, string>();
    sections.forEach((s) => s.defines.forEach((d) => owner.set(d, s.file)));
    const byFile = new Map<string, Section[]>();
    sections.forEach((s) => byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]));
    for (const [file, fileSections] of byFile) {
      const imports = new Map<string, Set<string>>();
      for (const section of fileSections) {
        for (const ref of section.references) {
          const from = owner.get(ref);
          if (!from || from === file) continue;
          imports.set(from, (imports.get(from) ?? new Set()).add(ref));
        }
      }
      const importLines = [...imports.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([from, names]) => `import { ${[...names].sort().join(', ')} } from './${from}${importExtension}';`);
      files.push({
        path: `${file}${ext}`,
        content: `${header(spec)}\n${[zodImport, ...importLines].join('\n')}\n\n${fileSections.map((s) => s.code).join('\n\n')}\n`,
      });
    }
    const fileNames = [...byFile.keys()];
    const partNames = opEntries.flatMap((e) => e.parts.map((p) => ({ name: p.name, file: e.file })));
    const indexImports =
      operationsMap && opEntries.length
        ? [...new Set(partNames.map((p) => p.file))].map(
            (file) =>
              `import { ${partNames.filter((p) => p.file === file).map((p) => p.name).join(', ')} } from './${file}${importExtension}';`,
          )
        : [];
    files.push({
      path: `index${ext}`,
      content: `${header(spec)}\n${fileNames.map((f) => `export * from './${f}${importExtension}';`).join('\n')}\n${
        indexImports.length ? `${indexImports.join('\n')}\n\n${operationsCode()}\n` : ''
      }`,
    });
  }

  // Keep only names that exist in the produced layout.
  for (const e of exports) if (splitBy === 'none') e.file = files[0]?.path ?? e.file;
  else e.file = `${e.file}${ext}`;

  return { files, operations, exports, warnings };
};
