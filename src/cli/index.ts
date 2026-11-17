import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { Command, Option } from 'commander';
import pc from 'picocolors';
import { loadSpec } from '../core/load.js';
import { listOperations } from '../core/operations.js';
import { selectOperations } from '../core/select.js';
import type { OperationSelector } from '../core/types.js';
import { generate } from '../generator/index.js';
import { formatOperations, formatReport } from '../reporter/index.js';
import type { ReportFormat } from '../reporter/index.js';
import { check, shouldFail } from '../validator/check.js';
import type { FailOn } from '../validator/check.js';
import { VERSION } from '../version.js';
import { CONFIG_TEMPLATE, loadConfig } from './config.js';
import type { OpenApiZodSyncConfig } from './config.js';

/** Exit codes: 0 = success, 1 = drift above threshold, 2 = usage or runtime error. */
export const EXIT = { ok: 0, drift: 1, error: 2 } as const;

interface SelectionFlags {
  all?: boolean;
  operation?: string[];
  tag?: string[];
  path?: string[];
  method?: string[];
  deprecated?: boolean;
}

const splitList = (values: string[] | undefined): string[] | undefined => {
  const list = values?.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  return list?.length ? list : undefined;
};

const toSelector = (flags: SelectionFlags, fallback?: OperationSelector): OperationSelector | undefined => {
  const selector: OperationSelector = {
    ...(flags.all ? { all: true } : {}),
    ...(splitList(flags.operation) ? { operationIds: splitList(flags.operation) } : {}),
    ...(splitList(flags.tag) ? { tags: splitList(flags.tag) } : {}),
    ...(splitList(flags.path) ? { paths: splitList(flags.path) } : {}),
    ...(splitList(flags.method) ? { methods: splitList(flags.method) } : {}),
    ...(flags.deprecated === false ? { includeDeprecated: false } : {}),
  };
  return Object.keys(selector).length ? selector : fallback;
};

const addSelectionOptions = (command: Command): Command =>
  command
    .option('--all', 'select all operations (default when no filter is given)')
    .option('-O, --operation <ids...>', 'operationId(s), space or comma separated')
    .option('-t, --tag <tags...>', 'tag(s)')
    .option('-p, --path <globs...>', "path glob(s), e.g. '/pets/**'")
    .option('-m, --method <methods...>', 'HTTP method(s)')
    .option('--no-deprecated', 'skip deprecated operations');

const resolveSpec = (arg: string | undefined, config: OpenApiZodSyncConfig): string => {
  const spec = arg ?? config.spec;
  if (!spec) throw new Error('No OpenAPI spec given. Pass it as an argument or set "spec" in openapi-zod-sync.config.ts.');
  return spec;
};

const run = async (action: () => Promise<number | void>): Promise<void> => {
  try {
    process.exitCode = (await action()) ?? EXIT.ok;
  } catch (error) {
    process.stderr.write(`${pc.red('error')} ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT.error;
  }
};

export const createProgram = (): Command => {
  const program = new Command('openapi-zod-sync')
    .description('Keep your OpenAPI contracts and Zod schemas in sync.')
    .version(VERSION)
    .option('-c, --config <file>', 'config file (default: openapi-zod-sync.config.{ts,js,json})')
    .option('--no-remote-refs', 'forbid resolving $refs over HTTP(S)')
    .option('--no-validate', 'skip OpenAPI document validation');

  const globals = (): { config?: string; remoteRefs: boolean; validate: boolean } =>
    program.opts() as { config?: string; remoteRefs: boolean; validate: boolean };

  // list ---------------------------------------------------------------------
  addSelectionOptions(
    program
      .command('list')
      .description('list operations in the spec (use it to pick what to generate or check)')
      .argument('[spec]', 'OpenAPI file or URL')
      .option('--json', 'machine-readable output'),
  ).action((specArg: string | undefined, flags: SelectionFlags & { json?: boolean }) =>
    run(async () => {
      const { config } = await loadConfig(globals().config);
      const spec = await loadSpec(resolveSpec(specArg, config), {
        remoteRefs: globals().remoteRefs && config.remoteRefs !== false,
        validate: globals().validate,
      });
      const operations = selectOperations(listOperations(spec.document), toSelector(flags));
      if (flags.json) {
        const rows = operations.map((op) => ({
          operationId: op.operationId,
          syntheticId: op.syntheticId,
          method: op.method.toUpperCase(),
          path: op.path,
          tags: op.tags,
          summary: op.summary,
          deprecated: op.deprecated,
          parts: op.parts.map((p) => p.key),
        }));
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatOperations(operations)}\n`);
      }
    }),
  );

  // generate -----------------------------------------------------------------
  addSelectionOptions(
    program
      .command('generate')
      .alias('gen')
      .description('generate Zod schemas from one, some or all operations')
      .argument('[spec]', 'OpenAPI file or URL')
      .option('-o, --output <path>', 'output file (or directory with --split-by tag)')
      .option('--stdout', 'print to stdout instead of writing files')
      .addOption(new Option('--split-by <mode>', 'file layout').choices(['none', 'tag']))
      .option('--strict-objects', 'use z.strictObject when additionalProperties is unspecified')
      .option('--no-coerce-params', 'do not coerce path/query/header values from strings')
      .option('--no-types', 'do not emit `export type X = z.infer<typeof X>`')
      .option('--no-descriptions', 'do not emit .describe() from OpenAPI descriptions')
      .option('--no-operations-map', 'do not emit the `operations` index')
      .option('--register', 'attach .meta({ openapi: { operationId, part } }) to each schema'),
  ).action(
    (
      specArg: string | undefined,
      flags: SelectionFlags & {
        output?: string;
        stdout?: boolean;
        splitBy?: 'none' | 'tag';
        strictObjects?: boolean;
        coerceParams: boolean;
        types: boolean;
        descriptions: boolean;
        operationsMap: boolean;
        register?: boolean;
      },
    ) =>
      run(async () => {
        const { config } = await loadConfig(globals().config);
        // `output` is taken out of the config options: with --stdout nothing may be written.
        const { output: configOutput, ...g } = config.generate ?? {};
        const output = flags.stdout ? undefined : (flags.output ?? configOutput);
        if (!output && !flags.stdout) throw new Error('No output given. Use -o <file>, --stdout, or set generate.output in the config.');
        const result = await generate(resolveSpec(specArg, config), {
          ...g,
          remoteRefs: globals().remoteRefs && config.remoteRefs !== false,
          validate: globals().validate,
          select: toSelector(flags, g.select),
          splitBy: flags.splitBy ?? g.splitBy ?? 'none',
          strictObjects: flags.strictObjects ?? g.strictObjects ?? false,
          coerceParams: flags.coerceParams && g.coerceParams !== false,
          ...(flags.types === false ? { typescript: false } : g.typescript !== undefined ? { typescript: g.typescript } : {}),
          descriptions: flags.descriptions && g.descriptions !== false,
          operationsMap: flags.operationsMap && g.operationsMap !== false,
          register: flags.register ?? g.register ?? false,
          ...(output ? { output } : {}),
        });
        if (flags.stdout) {
          process.stdout.write(result.files.map((f) => (result.files.length > 1 ? `// ==== ${f.path}\n${f.content}` : f.content)).join('\n'));
        } else {
          const cwd = process.cwd();
          for (const file of result.written) process.stderr.write(`${pc.green('wrote')} ${relative(cwd, file)}\n`);
          process.stderr.write(
            `${result.operations.length} operation(s), ${result.exports.length} schema export(s)${result.warnings.length ? `, ${result.warnings.length} warning(s)` : ''}\n`,
          );
        }
        for (const warning of result.warnings) process.stderr.write(`${pc.yellow('warn')} ${warning}\n`);
      }),
  );

  // check --------------------------------------------------------------------
  addSelectionOptions(
    program
      .command('check')
      .description('check existing Zod schemas against the spec and report drift')
      .argument('[spec]', 'OpenAPI file or URL')
      .option('-s, --schemas <globs...>', 'files or globs of modules exporting Zod schemas')
      .addOption(new Option('-f, --format <format>', 'report format').choices(['text', 'json', 'markdown']))
      .option('--out <file>', 'write the report to a file')
      .addOption(new Option('--fail-on <level>', 'exit with code 1 at this level').choices(['error', 'warning', 'never']))
      .option('--no-missing', 'do not report operation parts without a Zod schema')
      .option('--only-problems', 'text format: hide targets without issues'),
  ).action(
    (
      specArg: string | undefined,
      flags: SelectionFlags & {
        schemas?: string[];
        format?: ReportFormat;
        out?: string;
        failOn?: FailOn;
        missing: boolean;
        onlyProblems?: boolean;
      },
    ) =>
      run(async () => {
        const { config } = await loadConfig(globals().config);
        const c = config.check ?? {};
        const schemas = splitList(flags.schemas) ?? c.schemas;
        if (!schemas?.length) throw new Error('No schema files given. Use --schemas <glob> or set check.schemas in the config.');
        const report = await check(resolveSpec(specArg, config), {
          schemas,
          remoteRefs: globals().remoteRefs && config.remoteRefs !== false,
          validate: globals().validate,
          ...(toSelector(flags, c.select) ? { select: toSelector(flags, c.select) } : {}),
          ...(c.mapping ? { mapping: c.mapping } : {}),
          ...(c.severity ? { severity: c.severity } : {}),
          ...(c.missingSeverity ? { missingSeverity: c.missingSeverity } : {}),
          reportMissing: flags.missing && c.reportMissing !== false,
        });
        const format = flags.format ?? c.format ?? 'text';
        const out = flags.out ?? c.out;
        const rendered = formatReport(report, format, {
          showOk: !flags.onlyProblems,
          color: out ? false : undefined,
        });
        if (out) {
          await mkdir(dirname(resolve(out)), { recursive: true });
          await writeFile(resolve(out), format === 'text' ? `${rendered}\n` : rendered, 'utf8');
          process.stderr.write(`${pc.green('wrote')} ${out}\n`);
        } else {
          process.stdout.write(format === 'text' ? `${rendered}\n` : rendered);
        }
        return shouldFail(report, flags.failOn ?? c.failOn ?? 'error') ? EXIT.drift : EXIT.ok;
      }),
  );

  // init ---------------------------------------------------------------------
  program
    .command('init')
    .description('create openapi-zod-sync.config.ts')
    .option('--force', 'overwrite an existing config')
    .action((flags: { force?: boolean }) =>
      run(async () => {
        const target = resolve('openapi-zod-sync.config.ts');
        if (existsSync(target) && !flags.force) throw new Error(`${target} already exists (use --force to overwrite).`);
        await writeFile(target, CONFIG_TEMPLATE, 'utf8');
        process.stderr.write(`${pc.green('created')} openapi-zod-sync.config.ts\n`);
      }),
    );

  return program;
};
