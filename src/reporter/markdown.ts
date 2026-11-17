import type { CheckReport } from '../validator/check.js';

const escapeCell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const STATUS: Record<string, string> = { ok: '✅ ok', drift: '❌ drift', missing: '⚠️ missing', covered: '↪️ covered' };

/** Markdown report, suitable for PR comments, CI job summaries and docs. */
export const formatMarkdown = (report: CheckReport): string => {
  const s = report.summary;
  const out: string[] = [
    `# OpenAPI ⇄ Zod sync report`,
    '',
    `**Spec:** ${report.spec.title} ${report.spec.version} (OpenAPI ${report.spec.openapi})  `,
    `**Result:** ${s.errors} errors, ${s.warnings} warnings, ${s.infos} info across ${s.targets} targets ` +
      `(${s.ok} ok, ${s.drift} drift, ${s.missing} missing, ${s.covered} covered)`,
    '',
    '| Status | Target | Endpoint | Zod schema | Issues |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const r of report.results) {
    const endpoint = r.kind === 'operation' ? `\`${r.method} ${r.path}\`` : 'component';
    const schema = r.match ? `\`${r.match.export}\` (${r.match.file})` : r.coveredBy ? `via \`${r.coveredBy}\`` : '—';
    out.push(`| ${STATUS[r.status]} | \`${escapeCell(r.target)}\` | ${endpoint} | ${escapeCell(schema)} | ${r.issues.length} |`);
  }

  const withIssues = report.results.filter((r) => r.issues.length > 0);
  if (withIssues.length) {
    out.push('', '## Details');
    for (const r of withIssues) {
      out.push('', `### \`${r.target}\``, '', '| Severity | Code | Path | Message | Suggestion |', '| --- | --- | --- | --- | --- |');
      for (const i of r.issues) {
        out.push(
          `| ${i.severity} | ${i.code} | ${i.path ? `\`${escapeCell(i.path)}\`` : '(root)'} | ${escapeCell(i.message)} | ${escapeCell(i.suggestion ?? '')} |`,
        );
      }
    }
  }
  if (report.unmatchedExports.length) {
    out.push('', `_Unmatched Zod exports (not compared): ${report.unmatchedExports.map((e) => `\`${e.name}\``).join(', ')}_`);
  }
  return `${out.join('\n')}\n`;
};
