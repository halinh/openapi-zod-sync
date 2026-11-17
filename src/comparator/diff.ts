import { UNVERIFIABLE_FORMATS } from '../core/formats.js';
import type { Issue, IssueCode, SchemaMode, Severity } from '../core/types.js';
import { normalize } from './normalize.js';
import type { BaseType, SchemaRef, Shape } from './normalize.js';

/**
 * Severity model:
 *  - error   → Zod rejects data the contract allows (stricter), or the structure differs.
 *  - warning → Zod accepts data the contract forbids (looser).
 *  - info    → cannot be verified.
 */
export interface DiffOptions {
  mode: SchemaMode;
  /** Produce a Zod snippet for an expected (OpenAPI) sub-schema, used in suggestions. */
  suggest?: (expected: SchemaRef) => string | undefined;
}

interface DiffState {
  options: DiffOptions;
  issues: Issue[];
  visited: WeakMap<object, WeakSet<object>>;
}

const joinPath = (base: string, key: string): string => {
  const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
  return base ? `${base}.${safeKey}` : safeKey;
};

const describeTypes = (shape: Shape): string => {
  if (shape.any) return 'any';
  if (shape.variants) return `union of ${shape.variants.length} variants`;
  const types = [...shape.types];
  return types.length ? types.join(' | ') : shape.nullable ? 'null' : 'any';
};

const push = (
  state: DiffState,
  code: IssueCode,
  severity: Severity,
  path: string,
  message: string,
  extra: { expected?: unknown; actual?: unknown; suggestion?: string } = {},
): void => {
  state.issues.push({
    code,
    severity,
    path,
    message,
    ...(extra.expected !== undefined ? { expected: extra.expected } : {}),
    ...(extra.actual !== undefined ? { actual: extra.actual } : {}),
    ...(extra.suggestion ? { suggestion: extra.suggestion } : {}),
  });
};

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const typesCompatible = (expected: Set<BaseType>, actual: Set<BaseType>, enumsOnBothSides: boolean): boolean => {
  const norm = (set: Set<BaseType>): string[] =>
    [...set].map((t) => (enumsOnBothSides && t === 'integer' ? 'number' : t)).sort();
  return JSON.stringify(norm(expected)) === JSON.stringify(norm(actual));
};

type BoundKind = 'lower' | 'upper';

interface BoundSpec {
  key: 'minLength' | 'maxLength' | 'minItems' | 'maxItems';
  kind: BoundKind;
  zod: (value: number) => string;
}

const BOUNDS: BoundSpec[] = [
  { key: 'minLength', kind: 'lower', zod: (v) => `.min(${v})` },
  { key: 'maxLength', kind: 'upper', zod: (v) => `.max(${v})` },
  { key: 'minItems', kind: 'lower', zod: (v) => `.min(${v})` },
  { key: 'maxItems', kind: 'upper', zod: (v) => `.max(${v})` },
];

/**
 * One effective numeric bound. `minimum`/`exclusiveMinimum` (and the maximums)
 * are merged so that equivalent forms such as `.gt(0)` and `minimum: 1` on an
 * integer compare as equal, and each side yields at most one issue.
 */
interface NumericBound {
  key: 'minimum' | 'maximum' | 'exclusiveMinimum' | 'exclusiveMaximum';
  /** The keyword value as written. */
  value: number;
  exclusive: boolean;
  /** Value used for ordering; for integers, exclusive bounds become inclusive ones. */
  rank: number;
}

/** True when bound `x` admits fewer values than bound `y`. */
const isStricterBound = (x: NumericBound, y: NumericBound, kind: BoundKind): boolean => {
  if (x.rank !== y.rank) return kind === 'lower' ? x.rank > y.rank : x.rank < y.rank;
  return x.exclusive && !y.exclusive;
};

const numericBound = (shape: Shape, kind: BoundKind, integer: boolean): NumericBound | undefined => {
  const inclusiveKey = kind === 'lower' ? 'minimum' : 'maximum';
  const exclusiveKey = kind === 'lower' ? 'exclusiveMinimum' : 'exclusiveMaximum';
  const rankOf = (value: number, exclusive: boolean): number => {
    if (!integer) return value;
    if (kind === 'lower') return exclusive ? Math.floor(value) + 1 : Math.ceil(value);
    return exclusive ? Math.ceil(value) - 1 : Math.floor(value);
  };
  const candidates: NumericBound[] = [];
  const inclusive = shape[inclusiveKey];
  const exclusive = shape[exclusiveKey];
  if (inclusive !== undefined) candidates.push({ key: inclusiveKey, value: inclusive, exclusive: false, rank: rankOf(inclusive, false) });
  if (exclusive !== undefined) {
    // For integers the ranks are inclusive, so exclusivity no longer matters for ordering.
    candidates.push({ key: exclusiveKey, value: exclusive, exclusive: !integer, rank: rankOf(exclusive, true) });
  }
  return candidates.reduce<NumericBound | undefined>(
    (best, candidate) => (best === undefined || isStricterBound(candidate, best, kind) ? candidate : best),
    undefined,
  );
};

const boundZod = (bound: NumericBound): string =>
  ({ minimum: `.min(${bound.value})`, maximum: `.max(${bound.value})`, exclusiveMinimum: `.gt(${bound.value})`, exclusiveMaximum: `.lt(${bound.value})` })[bound.key];

const compareNumericBounds = (state: DiffState, e: Shape, a: Shape, path: string): void => {
  const integer = e.types.has('integer') && a.types.has('integer');
  for (const kind of ['lower', 'upper'] as const) {
    const ev = numericBound(e, kind, integer);
    const av = numericBound(a, kind, integer);
    if (av === undefined) {
      if (ev !== undefined) {
        push(state, 'CONSTRAINT_MISMATCH', 'warning', path, `Zod is missing ${ev.key} = ${ev.value}.`, {
          expected: ev.value,
          suggestion: `Add \`${boundZod(ev)}\`.`,
        });
      }
      continue;
    }
    if (ev === undefined) {
      push(state, 'CONSTRAINT_MISMATCH', 'error', path, `Zod adds ${av.key} = ${av.value}, which the contract does not define (rejects valid data).`, {
        actual: av.value,
        suggestion: `Remove the ${av.key} constraint.`,
      });
      continue;
    }
    const stricter = isStricterBound(av, ev, kind);
    if (!stricter && !isStricterBound(ev, av, kind)) continue; // equivalent bounds
    const detail = ev.key === av.key ? `${ev.key} differs: contract ${ev.value}, Zod ${av.value}` : `${kind} bound differs: contract ${ev.key} ${ev.value}, Zod ${av.key} ${av.value}`;
    push(
      state,
      'CONSTRAINT_MISMATCH',
      stricter ? 'error' : 'warning',
      path,
      `${detail}${stricter ? ' (Zod rejects valid data)' : ' (Zod accepts invalid data)'}.`,
      { expected: ev.value, actual: av.value, suggestion: `Use \`${boundZod(ev)}\`.` },
    );
  }
};

const compareConstraints = (state: DiffState, e: Shape, a: Shape, path: string): void => {
  compareNumericBounds(state, e, a, path);
  for (const bound of BOUNDS) {
    const ev = e[bound.key];
    const av = a[bound.key];
    if (ev === av) continue;
    if (ev !== undefined && av === undefined) {
      push(state, 'CONSTRAINT_MISMATCH', 'warning', path, `Zod is missing ${bound.key} = ${ev}.`, {
        expected: ev,
        suggestion: `Add \`${bound.zod(ev)}\`.`,
      });
      continue;
    }
    // Stricter when Zod's lower bound is higher, or its upper bound lower, than the contract.
    const stricter =
      ev === undefined ||
      (bound.kind === 'lower' ? (av as number) > ev : (av as number) < ev);
    push(
      state,
      'CONSTRAINT_MISMATCH',
      stricter ? 'error' : 'warning',
      path,
      ev === undefined
        ? `Zod adds ${bound.key} = ${av}, which the contract does not define (rejects valid data).`
        : `${bound.key} differs: contract ${ev}, Zod ${av}${stricter ? ' (Zod rejects valid data)' : ' (Zod accepts invalid data)'}.`,
      {
        ...(ev !== undefined ? { expected: ev } : {}),
        actual: av,
        suggestion: ev === undefined ? `Remove the ${bound.key} constraint.` : `Use \`${bound.zod(ev)}\`.`,
      },
    );
  }

  if (e.multipleOf !== a.multipleOf) {
    const missing = a.multipleOf === undefined;
    push(state, 'CONSTRAINT_MISMATCH', missing ? 'warning' : 'error', path, `multipleOf differs: contract ${e.multipleOf ?? 'none'}, Zod ${a.multipleOf ?? 'none'}.`, {
      ...(e.multipleOf !== undefined ? { expected: e.multipleOf, suggestion: `Use \`.multipleOf(${e.multipleOf})\`.` } : {}),
      ...(a.multipleOf !== undefined ? { actual: a.multipleOf } : {}),
    });
  }

  if (e.uniqueItems !== a.uniqueItems) {
    push(
      state,
      'CONSTRAINT_MISMATCH',
      e.uniqueItems ? 'warning' : 'error',
      path,
      e.uniqueItems ? 'Contract requires unique items; Zod does not enforce it.' : 'Zod enforces unique items; the contract does not.',
      {
        expected: e.uniqueItems,
        actual: a.uniqueItems,
        ...(e.uniqueItems
          ? { suggestion: 'Add `.refine((items) => new Set(items).size === items.length).meta({ uniqueItems: true })`.' }
          : {}),
      },
    );
  }

  // Patterns: only compared when the contract defines one, or when Zod adds a
  // custom regex (patterns implied by z.email()/z.uuid()… are ignored).
  if (e.pattern !== undefined && e.pattern !== a.pattern) {
    push(state, 'CONSTRAINT_MISMATCH', a.pattern === undefined ? 'warning' : 'error', path, `pattern differs: contract /${e.pattern}/, Zod ${a.pattern ? `/${a.pattern}/` : 'none'}.`, {
      expected: e.pattern,
      ...(a.pattern ? { actual: a.pattern } : {}),
      suggestion: `Use \`.regex(new RegExp(${JSON.stringify(e.pattern)}))\`.`,
    });
  } else if (e.pattern === undefined && a.pattern !== undefined && a.format === undefined) {
    push(state, 'CONSTRAINT_MISMATCH', 'error', path, `Zod adds pattern /${a.pattern}/ that the contract does not define.`, {
      actual: a.pattern,
      suggestion: 'Remove the regex or add the pattern to the OpenAPI schema.',
    });
  }
};

const compareFormat = (state: DiffState, e: Shape, a: Shape, path: string): void => {
  if (e.format === a.format) return;
  if (e.format && UNVERIFIABLE_FORMATS.has(e.format)) return;
  if (e.format && !a.format) {
    push(state, 'FORMAT_MISMATCH', 'warning', path, `Contract expects format "${e.format}"; Zod validates a plain value.`, {
      expected: e.format,
      suggestion: `Use the matching Zod format (e.g. z.${e.format === 'date-time' ? 'iso.datetime()' : e.format === 'uri' ? 'url()' : `${e.format}()`}).`,
    });
    return;
  }
  push(state, 'FORMAT_MISMATCH', 'error', path, e.format ? `Format differs: contract "${e.format}", Zod "${a.format}".` : `Zod enforces format "${a.format}" that the contract does not define.`, {
    ...(e.format ? { expected: e.format } : {}),
    actual: a.format,
  });
};

const compareEnums = (state: DiffState, e: Shape, a: Shape, path: string): void => {
  if (!e.enumValues && !a.enumValues) return;
  if (e.enumValues && !a.enumValues) {
    push(state, 'ENUM_MISMATCH', 'warning', path, `Contract restricts values to ${JSON.stringify(e.enumValues)}; Zod accepts any ${describeTypes(a)}.`, {
      expected: e.enumValues,
      suggestion: e.enumValues.length === 1 ? `Use \`z.literal(${JSON.stringify(e.enumValues[0])})\`.` : `Use \`z.enum(${JSON.stringify(e.enumValues)})\`.`,
    });
    return;
  }
  if (!e.enumValues && a.enumValues) {
    push(state, 'ENUM_MISMATCH', 'error', path, `Zod restricts values to ${JSON.stringify(a.enumValues)}; the contract accepts any ${describeTypes(e)}.`, {
      actual: a.enumValues,
    });
    return;
  }
  const missing = (e.enumValues ?? []).filter((v) => !(a.enumValues ?? []).some((w) => sameValue(v, w)));
  const extra = (a.enumValues ?? []).filter((v) => !(e.enumValues ?? []).some((w) => sameValue(v, w)));
  if (missing.length) {
    push(state, 'ENUM_MISMATCH', 'error', path, `Zod is missing enum value(s) ${JSON.stringify(missing)}.`, {
      expected: e.enumValues,
      actual: a.enumValues,
      suggestion: `Use \`z.enum(${JSON.stringify(e.enumValues)})\`.`,
    });
  }
  if (extra.length) {
    push(state, 'ENUM_MISMATCH', 'warning', path, `Zod accepts enum value(s) ${JSON.stringify(extra)} not in the contract.`, {
      expected: e.enumValues,
      actual: a.enumValues,
      suggestion: `Remove ${JSON.stringify(extra)} from the Zod enum.`,
    });
  }
};

const compareObjects = (state: DiffState, e: Shape, a: Shape, path: string): void => {
  const { mode } = state.options;
  const expectedProps = e.properties ?? new Map();
  const actualProps = a.properties ?? new Map();

  for (const [key, prop] of expectedProps) {
    const propPath = joinPath(path, key);
    const hidden = (mode === 'request' && prop.readOnly) || (mode === 'response' && prop.writeOnly);
    // In component mode, readOnly/writeOnly fields may legitimately be absent.
    const flexible = mode === 'component' && (prop.readOnly || prop.writeOnly);
    const actual = actualProps.get(key);
    if (hidden) continue;
    if (!actual) {
      if (flexible) continue;
      const snippet = state.options.suggest?.(prop.schema);
      const required = prop.required && !prop.hasDefault;
      push(state, 'MISSING_FIELD', required ? 'error' : 'warning', propPath, `${required ? 'Required' : 'Optional'} field "${key}" is missing from the Zod schema${required ? '' : ' (it will be stripped on parse)'}.`, {
        expected: required ? 'required' : 'optional',
        ...(snippet ? { suggestion: `Add \`${key}: ${snippet}${required ? '' : '.optional()'}\`.` } : {}),
      });
      continue;
    }
    const expectedRequired = prop.required && !prop.hasDefault;
    const actualRequired = actual.required && !actual.hasDefault;
    if (!flexible && expectedRequired !== actualRequired) {
      push(
        state,
        'OPTIONALITY_MISMATCH',
        actualRequired ? 'error' : 'warning',
        propPath,
        actualRequired
          ? `Field "${key}" is optional in the contract but required in Zod (rejects valid data).`
          : `Field "${key}" is required in the contract but optional in Zod (accepts invalid data).`,
        {
          expected: expectedRequired ? 'required' : 'optional',
          actual: actualRequired ? 'required' : 'optional',
          suggestion: actualRequired ? 'Add `.optional()`.' : 'Remove `.optional()`.',
        },
      );
    }
    diffRefs(state, prop.schema, actual.schema, propPath);
  }

  for (const [key, actual] of actualProps) {
    const expected = expectedProps.get(key);
    const hiddenFlag = expected && mode === 'request' && expected.readOnly ? 'readOnly' : expected && mode === 'response' && expected.writeOnly ? 'writeOnly' : undefined;
    if (expected && !hiddenFlag) continue;
    const required = actual.required && !actual.hasDefault;
    const reason = hiddenFlag
      ? ` but is ${hiddenFlag} in the contract (not part of ${mode === 'request' ? 'requests' : 'responses'})`
      : ' but not in the contract';
    push(state, 'EXTRA_FIELD', required ? 'error' : 'warning', joinPath(path, key), `Field "${key}" exists in Zod${reason}${required ? ' and is required (rejects valid data)' : ''}.`, {
      actual: required ? 'required' : 'optional',
      suggestion: hiddenFlag
        ? `Remove "${key}" from this ${mode} schema (e.g. \`.omit({ ${key}: true })\`).`
        : `Remove "${key}" from the Zod schema or add it to the OpenAPI schema.`,
    });
  }

  // Additional properties: only typed maps are compared; "false" vs "unspecified" is ignored
  // because z.object() strips unknown keys either way.
  if (e.additional && typeof e.additional === 'object') {
    if (a.additional && typeof a.additional === 'object') {
      diffRefs(state, e.additional, a.additional, joinPath(path, '*'));
    } else {
      push(state, 'CONSTRAINT_MISMATCH', 'warning', joinPath(path, '*'), 'Contract allows additional properties; Zod does not declare them (they will be stripped or rejected).', {
        suggestion: expectedProps.size ? 'Add `.catchall(<schema>)`.' : 'Use `z.record(z.string(), <schema>)`.',
      });
    }
  }
};

const compareVariants = (state: DiffState, e: Shape, a: Shape, path: string): void => {
  const expectedVariants = e.variants ?? [];
  const actualVariants = a.variants ?? [];
  if (!expectedVariants.length || !actualVariants.length) {
    push(state, 'TYPE_MISMATCH', 'error', path, `Type differs: contract ${describeTypes(e)}, Zod ${describeTypes(a)}.`, {
      expected: describeTypes(e),
      actual: describeTypes(a),
    });
    return;
  }
  // Match each contract variant with the Zod variant that produces the fewest issues.
  expectedVariants.forEach((expected, index) => {
    let best: Issue[] | undefined;
    for (const actual of actualVariants) {
      const sub: DiffState = { ...state, issues: [], visited: new WeakMap() };
      diffRefs(sub, expected, actual, path);
      const score = (issues: Issue[]): number =>
        issues.filter((i) => i.severity === 'error').length * 1000 + issues.length;
      if (!best || score(sub.issues) < score(best)) best = sub.issues;
      if (best.length === 0) break;
    }
    for (const issue of best ?? []) {
      state.issues.push({ ...issue, path: `${issue.path || path}<variant ${index}>` });
    }
  });
  if (actualVariants.length > expectedVariants.length) {
    push(state, 'TYPE_MISMATCH', 'warning', path, `Zod union has ${actualVariants.length} variants, contract has ${expectedVariants.length}.`, {
      expected: expectedVariants.length,
      actual: actualVariants.length,
    });
  }
};

const diffShapes = (state: DiffState, e: Shape, a: Shape, path: string, expectedRef: SchemaRef): void => {
  if (e.any) return;
  if (a.any) {
    if (e.format === 'binary') return;
    push(state, 'UNCOMPARABLE', 'warning', path, `Zod accepts any value here (z.any(), z.unknown(), z.custom() or a transform); contract expects ${describeTypes(e)}.`, {
      expected: describeTypes(e),
      actual: 'any',
    });
    return;
  }

  if (e.nullable !== a.nullable) {
    push(
      state,
      'NULLABILITY_MISMATCH',
      e.nullable ? 'error' : 'warning',
      path,
      e.nullable ? 'Contract allows null; Zod rejects it.' : 'Zod accepts null; the contract does not.',
      {
        expected: e.nullable ? 'nullable' : 'non-nullable',
        actual: a.nullable ? 'nullable' : 'non-nullable',
        suggestion: e.nullable ? 'Add `.nullable()`.' : 'Remove `.nullable()`.',
      },
    );
  }

  if (e.variants || a.variants) {
    compareVariants(state, e, a, path);
    return;
  }

  if (!typesCompatible(e.types, a.types, Boolean(e.enumValues && a.enumValues))) {
    const snippet = state.options.suggest?.(expectedRef);
    push(state, 'TYPE_MISMATCH', 'error', path, `Type differs: contract ${describeTypes(e)}, Zod ${describeTypes(a)}.`, {
      expected: describeTypes(e),
      actual: describeTypes(a),
      ...(snippet ? { suggestion: `Use \`${snippet}\`.` } : {}),
    });
    return;
  }

  compareEnums(state, e, a, path);
  compareFormat(state, e, a, path);
  compareConstraints(state, e, a, path);

  if (e.types.has('object') || e.properties) compareObjects(state, e, a, path);
  if (e.types.has('array') && e.items && a.items) diffRefs(state, e.items, a.items, `${path}[]`);
};

const diffRefs = (state: DiffState, expected: SchemaRef, actual: SchemaRef, path: string): void => {
  const e = normalize(expected);
  const a = normalize(actual);
  // Cycle guard: each (contract node, zod node) pair is compared once.
  let seen = state.visited.get(e.identity);
  if (!seen) state.visited.set(e.identity, (seen = new WeakSet()));
  if (seen.has(a.identity)) return;
  seen.add(a.identity);
  diffShapes(state, e, a, path, expected);
};

/** Diff an expected (OpenAPI) schema against an actual (Zod JSON Schema) one. */
export const diffSchemas = (expected: SchemaRef, actual: SchemaRef, options: DiffOptions): Issue[] => {
  const state: DiffState = { options, issues: [], visited: new WeakMap() };
  diffRefs(state, expected, actual, '');
  return state.issues;
};
