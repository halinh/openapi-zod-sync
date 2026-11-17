# Petstore example

This folder contains:

- `openapi.yaml`: an OpenAPI 3.1 contract with components, readOnly/writeOnly fields, a recursive schema, a discriminated union and `allOf`.
- `src/schemas.ts`: hand-written Zod schemas with **intentional drift**. Each drifted line is marked with a `// DRIFT:` comment.
- `generated/schemas.ts`: the output of `openapi-zod-sync generate`.
- `openapi-zod-sync.config.ts`: the config file. It maps `createPet.body` to `NewPetSchema`, a name that doesn't follow the convention.

Run the commands from this folder, after `npm run build` at the repository root:

```bash
node ../../dist/cli.js list                       # operations and their parts
node ../../dist/cli.js generate                   # regenerate generated/schemas.ts
node ../../dist/cli.js check                      # drift report for src/ (exit code 1)
node ../../dist/cli.js check -s generated/schemas.ts   # generated code is clean (exit code 0)
node ../../dist/cli.js check --format markdown --out report.md
```

What `check` finds in `src/schemas.ts`:

| Where | Drift | Severity |
| --- | --- | --- |
| `PetStatus` | `"pending"` missing from the enum | error |
| `Pet.name` | `max(30)`, but the contract says 50 | error |
| `Pet.weightKg` | required in Zod, optional in the contract | error |
| `Pet.owner` | not `.nullable()`, but the contract allows null | error |
| `Pet.tags` | `uniqueItems` not enforced | warning |
| `Owner.email` | plain string instead of `z.email()` | warning |
| `Owner.phone` | pattern missing | warning |
| `Pet.metadata` | field missing | warning |
| `Pet.nickname` | field not in the contract | warning |
| `listPets.query` | `includeArchived` missing | warning |
| many operation parts | no Zod schema at all (`MISSING_SCHEMA`) | warning |
