# openapi-zod-sync

**Keep your OpenAPI contracts and Zod schemas in sync.**

`openapi-zod-sync` is a TypeScript library and CLI for teams that maintain an OpenAPI specification and Zod validation schemas side by side. It does two things:

- It **generates** Zod v4 schemas from the spec, for one, several or all endpoints.
- It **checks** the Zod schemas you already have against the spec and reports drift: missing fields, wrong types, optional/required mismatches, nullability, enums, formats and constraints.

```text
$ npx openapi-zod-sync check

✖ #/components/schemas/Pet  component  → PetSchema (src/schemas.ts)
    error   CONSTRAINT_MISMATCH  name      maxLength differs: contract 50, Zod 30 (Zod rejects valid data).
                                ↳ Use `.max(50)`.
    error   ENUM_MISMATCH        status    Zod is missing enum value(s) ["pending"].
                                ↳ Use `z.enum(["available","pending","sold"])`.
    error   NULLABILITY_MISMATCH owner     Contract allows null; Zod rejects it.
                                ↳ Add `.nullable()`.
    warning MISSING_FIELD        metadata  Optional field "metadata" is missing from the Zod schema (it will be stripped on parse).
                                ↳ Add `metadata: z.record(z.string(), z.string()).optional()`.

Summary: 18 targets · 1 ok · 5 drift · 10 missing · 2 covered — 10 errors, 23 warnings, 0 info
```

## Features

- **Generate:** turn one, several or all OpenAPI operations into Zod schemas.
- **Validate:** check whether existing Zod schemas agree with the OpenAPI contract.
- **Compare:** detect missing or extra fields, wrong types, optionality and nullability mismatches, and differences in enums, formats and constraints.
- **Report:** output text, JSON (for CI and AI agents) or Markdown (for PR comments). Each issue comes with a ready-to-apply fix.
- **AI-ready:** ships a [Claude Code skill](#using-with-claude-code) so Claude can generate schemas and fix drift for you.

Supports OpenAPI **3.0** and **3.1**, and **Zod v4**.

## Install

```bash
npm i -D openapi-zod-sync
npm i zod@^4
```

## Quick start

```bash
npx openapi-zod-sync init                       # creates openapi-zod-sync.config.ts
npx openapi-zod-sync list openapi.yaml          # see operations and their parts
npx openapi-zod-sync generate openapi.yaml -o src/schemas/api.ts
npx openapi-zod-sync check openapi.yaml -s 'src/schemas/**/*.ts'
```

## Generate

Each operation part gets its own export. Shared `components.schemas` become named schemas that the parts reuse.

| Operation part | Export name |
| --- | --- |
| path parameters | `GetPetParams` |
| query parameters | `ListPetsQuery` |
| headers (lower-cased) | `ListPetsHeaders` |
| request body | `CreatePetBody` |
| responses | `CreatePetResponse201`, `GetPetResponse4XX`, `ListPetsResponseDefault` |
| component | `Pet` (plus `PetInput` when request and response shapes differ, see below) |

Choose what to generate. Filters of different kinds combine with AND, and several values in one filter combine with OR:

```bash
openapi-zod-sync generate spec.yaml -o api.ts                          # all operations
openapi-zod-sync generate spec.yaml -o api.ts --operation getPet       # one
openapi-zod-sync generate spec.yaml -o api.ts -O getPet,createPet      # some
openapi-zod-sync generate spec.yaml -o api.ts --tag pets --method post
openapi-zod-sync generate spec.yaml -o api.ts --path '/pets/**'
openapi-zod-sync generate spec.yaml -o src/api/ --split-by tag         # one file per tag
```

Example output:

```ts
export const Pet = z.object({
  id: z.int().min(1),
  name: z.string().min(1).max(50),
  status: PetStatus,
  owner: Owner.nullable().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});
export type Pet = z.infer<typeof Pet>;

/** Request query */
export const ListPetsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  includeArchived: z.stringbool().optional(),
});

export const operations = {
  getPet: { method: "get", path: "/pets/{petId}", params: GetPetParams, responses: { "200": GetPetResponse200 } },
  // ...
} as const;
```

What the generator handles:

- **Types and formats:** primitive types, formats (`email`, `uuid`, `uri`, `date-time` with offsets, `date`, `time`, `ipv4`/`ipv6`, `hostname`, `byte`) and their constraints.
- **Enums and constants:** `enum` and `const`.
- **Nullability:** 3.0 `nullable` and 3.1 `type: [..., "null"]`.
- **Objects and arrays:** `additionalProperties` (becomes `z.record`, `.catchall`, `z.strictObject` or `z.looseObject`), arrays, and `uniqueItems`.
- **Composition:** `allOf`, `oneOf`/`anyOf`, and `discriminator` (becomes `z.discriminatedUnion` when it is safe to use).
- **Recursion:** recursive schemas, using Zod v4 getters.
- **readOnly / writeOnly:** a component that contains such fields gets two schemas. `Pet` is the response shape and `PetInput` is the request shape. Request bodies use `PetInput`.
- **Parameters:** path, query and header values are coerced from strings (turn this off with `--no-coerce-params`).
- **Unsupported keywords** (`not`, `if`/`then`, `patternProperties`, …): reported as warnings and marked with a comment in the code. They are never dropped silently.

Generator options:

| Option | Effect |
| --- | --- |
| `--strict-objects` | use `z.strictObject` when `additionalProperties` is not set |
| `--register` | add `.meta({ openapi: { operationId, part } })` for robust matching |
| `--no-types` | don't emit `export type X = z.infer<typeof X>` (this is also the default for `.js` output) |
| `--no-descriptions` | don't emit `.describe(...)` |
| `--no-operations-map` | don't emit the `operations` index |
| `--stdout` | print the code instead of writing a file |

## Check

```bash
openapi-zod-sync check openapi.yaml -s 'src/**/*.ts' [--format text|json|markdown] [--out report.md] [--fail-on error|warning|never]
```

`check` imports your modules at runtime (TypeScript works through [jiti](https://github.com/unjs/jiti)) and collects every exported Zod schema. It then pairs each schema with a part of the spec, in this order:

1. **Config mapping:** `mapping: { 'createPet.body': 'NewPetSchema', '#/components/schemas/Pet': 'PetSchema' }`
2. **Metadata:** `.meta({ openapi: { operationId: 'createPet', part: 'body' } })`
3. **Naming convention:** the export names in the table above. Components may also be named with a `Schema` suffix (`PetSchema`).

If an operation part is a plain `$ref` to a component you have already checked, its status is **covered** and it isn't compared twice.

### How it compares

Both sides are converted to JSON Schema: Zod v4 through its own `z.toJSONSchema()`, the OpenAPI side through a normalization step. The two are then compared structurally. This step ignores details that come from Zod itself rather than from your contract, such as safe-integer bounds, the regexes behind `z.email()`, and closed objects. Request bodies are compared against what clients may send (Zod *input*). Responses and parameters are compared against the parsed *output*.

### Issue codes and severity

| Code | Example |
| --- | --- |
| `MISSING_FIELD` / `EXTRA_FIELD` | a field exists on one side only |
| `TYPE_MISMATCH` | `integer` vs `z.number()`, union vs object |
| `OPTIONALITY_MISMATCH` | required vs `.optional()` |
| `NULLABILITY_MISMATCH` | null allowed on one side only |
| `ENUM_MISMATCH` | missing or extra enum values |
| `FORMAT_MISMATCH` | `format: email` vs `z.string()` |
| `CONSTRAINT_MISMATCH` | min/max length, numeric bounds, items, pattern, multipleOf, uniqueItems |
| `MISSING_SCHEMA` | no Zod export found for an operation part (warning by default) |
| `UNCOMPARABLE` | Zod accepts anything there (`z.any()`, transforms) |

Severity follows one rule:

- An **error** means Zod **rejects data the contract allows**, or the structure differs.
- A **warning** means Zod **accepts data the contract forbids**.

For example, a Zod `max(30)` against a contract `maxLength: 50` is an error, while a missing `max()` is a warning.

To change a severity, set `severity: { CONSTRAINT_MISMATCH: 'off' }` or `missingSeverity: 'info'` in the config.

### CI

```yaml
- run: npx openapi-zod-sync check --format markdown --out sync-report.md --fail-on error
- run: cat sync-report.md >> "$GITHUB_STEP_SUMMARY"
  if: always()
```

Exit codes: `0` = OK, `1` = drift at or above `--fail-on`, `2` = usage or runtime error.

## Configuration

```ts
// openapi-zod-sync.config.ts
import { defineConfig } from 'openapi-zod-sync';

export default defineConfig({
  spec: './openapi.yaml',
  generate: { output: './src/schemas/api.ts', select: { tags: ['pets'] } },
  check: {
    schemas: ['./src/**/*.ts'],
    mapping: { 'createPet.body': 'NewPetSchema' },
    failOn: 'error',
  },
});
```

Options passed on the command line override the config file.

## Programmatic API

```ts
import { generate, check, compare, loadSpec, formatReport } from 'openapi-zod-sync';

// Generate code (and optionally write it)
const { files, warnings } = await generate('openapi.yaml', { select: { operationIds: ['getPet'] } });

// Check a whole project
const report = await check('openapi.yaml', { schemas: ['src/**/*.ts'] });
console.log(formatReport(report, 'markdown'));

// Compare one schema, e.g. in a unit test
const spec = await loadSpec('openapi.yaml');
const issues = compare(PetSchema, { $ref: '#/components/schemas/Pet' }, { document: spec.document, mode: 'response' });
expect(issues).toEqual([]);
```

## Using with Claude Code

The package ships a [Claude Code skill](skills/openapi-zod-sync/SKILL.md). It teaches Claude to:

- list the operations in your spec,
- generate exactly the endpoints you ask for,
- run `check --format json`,
- edit your hand-written schemas **in your own style** using each issue's `suggestion`,
- re-run `check` until it is clean.

The skill treats the spec as the source of truth and never overwrites hand-written files.

Install it in your project, or in `~/.claude/skills/` to have it in every project:

```bash
mkdir -p .claude/skills
cp -r node_modules/openapi-zod-sync/skills/openapi-zod-sync .claude/skills/
```

Then ask Claude things like:

- *"Generate Zod schemas for the createPet and getPet endpoints into src/schemas/pets.ts"*
- *"Are our Zod schemas still in sync with openapi.yaml? Fix whatever drifted."*
- *"Add an OpenAPI/Zod consistency check to our CI."*

## Security

- `check` **runs** the schema modules you point it at (it imports them at runtime). Only use it on code you trust.
- External `$ref`s are resolved, including over HTTP by default. Use `--no-remote-refs` (or `remoteRefs: false`) for untrusted specs.
- Generated code never uses `eval`. Identifiers are cleaned up from operationIds and schema names, and names that would shadow globals (`Error`, `Date`, …) get a suffix.

## Limitations

- Swagger 2.0 is not supported. Convert it to OpenAPI 3.x first (for example with `swagger2openapi`).
- Some keywords can't be expressed in Zod or JSON Schema output (`not`, `if`/`then`/`else`, `patternProperties`, tuples through `prefixItems`). The generator flags them and the comparator skips them.
- For each request body or response, the media type used is the first JSON-like one; otherwise it is the first media type that has a schema.

## License

MIT
