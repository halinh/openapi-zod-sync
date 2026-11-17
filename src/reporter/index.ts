import type { OperationInfo } from '../core/types.js';
import type { CheckReport } from '../validator/check.js';
import { formatMarkdown } from './markdown.js';
import { formatText } from './text.js';
import type { TextReportOptions } from './text.js';

export type ReportFormat = 'text' | 'json' | 'markdown';

/** JSON report: stable shape, intended for CI tooling and AI agents. */
export const formatJson = (report: CheckReport): string => `${JSON.stringify(report, null, 2)}\n`;

export const formatReport = (report: CheckReport, format: ReportFormat, options: TextReportOptions = {}): string => {
  switch (format) {
    case 'json':
      return formatJson(report);
    case 'markdown':
      return formatMarkdown(report);
    default:
      return formatText(report, options);
  }
};

/** Plain-text table of operations for `openapi-zod-sync list`. */
export const formatOperations = (operations: OperationInfo[]): string => {
  const rows = operations.map((op) => [
    op.operationId + (op.syntheticId ? '*' : ''),
    op.method.toUpperCase(),
    op.path,
    op.tags.join(',') || '-',
    op.parts.map((p) => p.key).join(' '),
  ]);
  const header = ['OPERATION', 'METHOD', 'PATH', 'TAGS', 'PARTS'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
  const line = (cells: string[]): string => cells.map((cell, i) => cell.padEnd(widths[i] as number)).join('  ').trimEnd();
  const out = [line(header), ...rows.map(line)];
  if (operations.some((op) => op.syntheticId)) out.push('', '* operationId derived from method + path (not defined in spec)');
  return out.join('\n');
};

export { formatMarkdown, formatText };
export type { TextReportOptions };
