/**
 * Single source of truth for OpenAPI string formats, shared by the generator
 * (what Zod code to emit) and the comparator (which format names are equivalent).
 */

/** OpenAPI format → Zod v4 factory expression. */
export const STRING_FORMAT_FACTORIES: Readonly<Record<string, string>> = {
  email: 'z.email()',
  uuid: 'z.uuid()',
  uri: 'z.url()',
  url: 'z.url()',
  'date-time': 'z.iso.datetime({ offset: true })',
  date: 'z.iso.date()',
  time: 'z.iso.time()',
  duration: 'z.iso.duration()',
  ipv4: 'z.ipv4()',
  ipv6: 'z.ipv6()',
  hostname: 'z.hostname()',
  byte: 'z.base64()',
};

/** Format names that denote the same thing on both sides. */
const FORMAT_ALIASES: Readonly<Record<string, string>> = {
  url: 'uri',
  byte: 'base64',
};

export const canonicalFormat = (format: string): string => FORMAT_ALIASES[format] ?? format;

/**
 * Formats that Zod validates but does not report in JSON Schema output, or that
 * are informational only (numeric widths, password hints, binary payloads).
 * A missing format on the Zod side is not reported for these.
 */
export const UNVERIFIABLE_FORMATS: ReadonlySet<string> = new Set([
  'time',
  'int32',
  'int64',
  'float',
  'double',
  'password',
  'binary',
]);
