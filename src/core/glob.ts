import { readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const escapeRegex = (value: string): string => value.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/**
 * Convert a small glob dialect into a RegExp:
 * `**` matches any number of segments, `*` matches within one segment, `?` one char.
 */
export const globToRegExp = (glob: string): RegExp => {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] as string;
    if (char === '/' && glob.slice(i + 1) === '**') {
      // Trailing "/**" also matches the parent itself: "/pets/**" matches "/pets".
      out += '(?:/.*)?';
      break;
    }
    if (char === '*') {
      if (glob[i + 1] === '*') {
        // "**/" or trailing "**": any depth, including zero segments.
        const followedBySlash = glob[i + 2] === '/';
        out += followedBySlash ? '(?:.*/)?' : '.*';
        i += followedBySlash ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += escapeRegex(char);
    }
  }
  return new RegExp(`^${out}$`);
};

export const matchesGlob = (value: string, glob: string): boolean => globToRegExp(glob).test(value);

const hasMagic = (pattern: string): boolean => /[*?]/.test(pattern);

const toPosix = (value: string): string => value.split(sep).join('/');

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist']);

const walk = (dir: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) files.push(...walk(join(dir, entry.name)));
    } else if (entry.isFile()) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
};

/**
 * Expand file patterns (plain paths or globs) relative to `cwd`.
 * Returns absolute, de-duplicated, sorted paths.
 */
export const expandFilePatterns = (patterns: string[], cwd: string = process.cwd()): string[] => {
  const found = new Set<string>();
  for (const pattern of patterns) {
    if (!hasMagic(pattern)) {
      const absolute = resolve(cwd, pattern);
      if (statSync(absolute, { throwIfNoEntry: false })?.isFile()) found.add(absolute);
      continue;
    }
    const posix = toPosix(pattern);
    // Walk from the static prefix of the glob to keep traversal small.
    const staticPart = posix.split('/').filter((_, idx, parts) => !parts.slice(0, idx + 1).some(hasMagic));
    const base = resolve(cwd, staticPart.join('/') || '.');
    if (!statSync(base, { throwIfNoEntry: false })?.isDirectory()) continue;
    const regex = globToRegExp(isAbsolute(posix) ? posix : toPosix(resolve(cwd, posix)));
    for (const file of walk(base)) {
      if (regex.test(toPosix(file))) found.add(file);
    }
  }
  return [...found].sort();
};

export const relativeToCwd = (file: string, cwd: string = process.cwd()): string => toPosix(relative(cwd, file));
