# Contributing

Thanks for helping. Bug reports with a minimal OpenAPI snippet and the Zod schema involved are the most useful thing you can send.

## Development

```bash
npm install
npm run typecheck
npm test          # vitest
npm run build     # tsup → dist/
node dist/cli.js check examples/petstore/openapi.yaml -s 'examples/petstore/src/**/*.ts'
```

Node 20 or later is required.

## Project layout

| Folder | Responsibility |
| --- | --- |
| `src/core` | types, spec loading, `$ref` helpers, operation model, selection, naming, formats |
| `src/generator` | OpenAPI schema → Zod code (`schemaToZod`), file layout (`emit`) |
| `src/comparator` | normalizes OpenAPI and Zod JSON Schema into one shape, then diffs them |
| `src/validator` | loads user modules, matches exports to the spec, runs `check()` |
| `src/reporter` | text / JSON / Markdown output |
| `src/cli` | commander program and config loading |
| `skills/` | the Claude Code skill shipped with the package |

## Rules for changes

- **Round-trip invariant:** for every fixture, the output of `generate` must pass `check` against the same spec with zero issues (see `tests/roundtrip.test.ts`). When you add support for a keyword, update the generator and the comparator together, and extend a fixture to cover it.
- **Severity rule:** an issue is an `error` when Zod rejects data the contract allows, or when the structure differs. It is a `warning` when Zod accepts data the contract forbids. New checks must follow this rule.
- **Formats:** the mapping lives in `src/core/formats.ts` and is shared by the generator and the comparator.
- TypeScript is strict. Use a functional style and give every exported function an explicit return type.
- Commit messages: `<type>(<scope>): <description>` (types: feat, fix, docs, style, refactor, test, chore), with a subject of at most 72 characters.

## Releasing

1. Update `version` in `package.json` and in `src/version.ts` (a test checks that they match).
2. Move the entries under `Unreleased` in `CHANGELOG.md` to the new version.
3. Run `npm publish`. The `prepublishOnly` script runs typecheck, tests and build first.
