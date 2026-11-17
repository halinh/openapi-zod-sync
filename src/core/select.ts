import { matchesGlob } from './glob.js';
import type { OperationInfo, OperationSelector } from './types.js';

const hasFilters = (selector: OperationSelector): boolean =>
  Boolean(selector.operationIds?.length || selector.tags?.length || selector.paths?.length || selector.methods?.length);

/**
 * Filter operations. Filters of different kinds are intersected (AND), values
 * within one filter are unioned (OR). With no filters, everything is selected.
 * Unknown operationIds raise an error so typos do not silently select nothing.
 */
export const selectOperations = (operations: OperationInfo[], selector: OperationSelector = {}): OperationInfo[] => {
  if (selector.operationIds?.length) {
    const known = new Set(operations.map((op) => op.operationId));
    const unknown = selector.operationIds.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new Error(`Unknown operationId(s): ${unknown.join(', ')}. Run "openapi-zod-sync list <spec>" to see available ids.`);
    }
  }

  const includeDeprecated = selector.includeDeprecated ?? true;
  if (selector.all || !hasFilters(selector)) {
    return operations.filter((op) => includeDeprecated || !op.deprecated);
  }

  const ids = selector.operationIds?.length ? new Set(selector.operationIds) : undefined;
  const tags = selector.tags?.length ? new Set(selector.tags) : undefined;
  const methods = selector.methods?.length ? new Set(selector.methods.map((m) => m.toLowerCase())) : undefined;
  const paths = selector.paths?.length ? selector.paths : undefined;

  return operations.filter(
    (op) =>
      (includeDeprecated || !op.deprecated) &&
      (!ids || ids.has(op.operationId)) &&
      (!tags || op.tags.some((tag) => tags.has(tag))) &&
      (!methods || methods.has(op.method)) &&
      (!paths || paths.some((glob) => matchesGlob(op.path, glob))),
  );
};
