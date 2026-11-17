# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

### Added

- `generate`: OpenAPI 3.0/3.1 → Zod v4 code for one, some or all operations, selected by operationId, tag, path glob or method.
- Output as a single file or split by tag. Includes inferred TypeScript types and an `operations` index.
- Read and write variants (`Pet` / `PetInput`) for components that have `readOnly`/`writeOnly` fields.
- Recursive schemas, discriminated unions, `allOf` composition, nullability in both 3.0 and 3.1 styles, and coerced parameters.
- `check`: imports Zod schemas at runtime and matches them to the spec by config mapping, `.meta({ openapi })`, or naming convention.
- `compare`: compares one Zod schema with one OpenAPI schema, using a shared JSON Schema representation.
- Issue codes: `MISSING_FIELD`, `EXTRA_FIELD`, `TYPE_MISMATCH`, `OPTIONALITY_MISMATCH`, `NULLABILITY_MISMATCH`, `ENUM_MISMATCH`, `FORMAT_MISMATCH`, `CONSTRAINT_MISMATCH`, `MISSING_SCHEMA`, `UNCOMPARABLE`. Each comes with a suggested fix.
- Text, JSON and Markdown reports, and CI-friendly exit codes (`--fail-on`).
- CLI commands `list`, `generate`, `check` and `init`, with a `defineConfig` config file.
- A Claude Code skill (`skills/openapi-zod-sync`).

### Fixed

- Security: `generate` no longer lets a crafted spec inject code into the generated source. Spec text placed in comments (`info.title`, `info.version`, media types, summaries) has line terminators removed and `*/` escaped. Numeric constraints (`minLength`, `maximum`, `multipleOf`, …) are emitted only when they are finite numbers; any other value is skipped with a warning.
- `CONSTRAINT_MISMATCH`: inclusive and exclusive numeric bounds (`minimum`/`exclusiveMinimum`, `maximum`/`exclusiveMaximum`) are compared as one bound. Equivalent integer bounds such as `minimum: 1` and `.positive()` no longer report drift, each bound reports at most one issue, and severity follows the stricter/looser rule (for example, `exclusiveMinimum: 0` against `.min(0)` is now a warning, not an error).
