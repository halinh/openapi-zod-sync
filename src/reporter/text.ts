import pc from 'picocolors';
import type { Issue, Severity } from '../core/types.js';
import type { CheckReport, CheckTargetResult, TargetStatus } from '../validator/check.js';

export interface TextReportOptions {
  /** Use ANSI colors (default: auto-detected by picocolors). */
  color?: boolean;
  /** Also list targets without issues (default: true). */
  showOk?: boolean;
}

const ICON: Record<TargetStatus, string> = { ok: '✔', drift: '✖', missing: '○', covered: '↪' };

export const formatText = (report: CheckReport, options: TextReportOptions = {}): string => {
  const c = pc.createColors(options.color ?? pc.isColorSupported);
  const showOk = options.showOk ?? true;
  const severityColor: Record<Severity, (s: string) => string> = { error: c.red, warning: c.yellow, info: c.blue };
  const statusColor: Record<TargetStatus, (s: string) => string> = {
    ok: c.green,
    drift: c.red,
    missing: c.yellow,
    covered: c.dim,
  };

  const lines: string[] = [
    c.bold(`openapi-zod-sync check — ${report.spec.title} ${report.spec.version} (OpenAPI ${report.spec.openapi})`),
    '',
  ];

  const targetLine = (r: CheckTargetResult): string => {
    const where = r.kind === 'operation' ? c.dim(`${r.method} ${r.path}`) : c.dim('component');
    const matched = r.match
      ? `→ ${r.match.export} ${c.dim(`(${r.match.file}${r.match.via === 'convention' ? '' : `, by ${r.match.via}`})`)}`
      : r.coveredBy
        ? c.dim(`covered by component check of ${r.coveredBy}`)
        : c.yellow('no Zod schema');
    return `${statusColor[r.status](ICON[r.status])} ${c.bold(r.target)}  ${where}  ${matched}`;
  };

  const issueLines = (issue: Issue): string[] => {
    const out = [
      `    ${severityColor[issue.severity](issue.severity.padEnd(7))} ${c.dim(issue.code.padEnd(20))} ${issue.path ? c.cyan(issue.path) + '  ' : ''}${issue.message}`,
    ];
    if (issue.suggestion) out.push(`    ${' '.repeat(28)}${c.dim(`↳ ${issue.suggestion}`)}`);
    return out;
  };

  for (const result of report.results) {
    if (!showOk && (result.status === 'ok' || result.status === 'covered')) continue;
    lines.push(targetLine(result));
    result.issues.forEach((issue) => lines.push(...issueLines(issue)));
  }

  if (report.unmatchedExports.length) {
    lines.push('', c.dim(`Unmatched Zod exports (not compared): ${report.unmatchedExports.map((e) => e.name).join(', ')}`));
  }

  const s = report.summary;
  lines.push(
    '',
    `${c.bold('Summary:')} ${s.targets} targets · ${c.green(`${s.ok} ok`)} · ${c.red(`${s.drift} drift`)} · ${c.yellow(`${s.missing} missing`)} · ${s.covered} covered — ` +
      `${c.red(`${s.errors} errors`)}, ${c.yellow(`${s.warnings} warnings`)}, ${s.infos} info`,
  );
  return lines.join('\n');
};
