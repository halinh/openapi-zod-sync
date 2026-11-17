import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { compare } from '../src/comparator/index.js';
import type { Issue, OpenApiDocument, SchemaObject } from '../src/core/types.js';

const codes = (issues: Issue[]): string[] => issues.map((i) => `${i.severity}:${i.code}:${i.path}`);

const User: SchemaObject = {
  type: 'object',
  required: ['id', 'email', 'role'],
  properties: {
    id: { type: 'integer', minimum: 1, readOnly: true },
    email: { type: 'string', format: 'email' },
    name: { type: 'string', maxLength: 50 },
    role: { type: 'string', enum: ['admin', 'user'] },
    password: { type: 'string', writeOnly: true, minLength: 8 },
    nickname: { type: ['string', 'null'] },
    tags: { type: 'array', items: { type: 'string' } },
  },
};

const ValidUser = z.object({
  id: z.int().min(1),
  email: z.email(),
  name: z.string().max(50).optional(),
  role: z.enum(['admin', 'user']),
  password: z.string().min(8).optional(),
  nickname: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
});

describe('compare', () => {
  it('finds nothing when schemas agree', () => {
    expect(compare(ValidUser, User)).toEqual([]);
  });

  it('reports missing and extra fields', () => {
    const issues = compare(ValidUser.omit({ email: true, name: true }).extend({ extra: z.string() }), User);
    expect(codes(issues)).toEqual([
      'error:MISSING_FIELD:email',
      'warning:MISSING_FIELD:name',
      'error:EXTRA_FIELD:extra',
    ]);
    expect(issues[0]!.suggestion).toBe('Add `email: z.email()`.');
  });

  it('reports type, optionality and nullability mismatches', () => {
    const issues = compare(
      ValidUser.extend({ email: z.number(), role: z.enum(['admin', 'user']).optional(), nickname: z.string().optional(), name: z.string().max(50) }),
      User,
    );
    expect(codes(issues)).toEqual([
      'error:TYPE_MISMATCH:email',
      'error:OPTIONALITY_MISMATCH:name',
      'warning:OPTIONALITY_MISMATCH:role',
      'error:NULLABILITY_MISMATCH:nickname',
    ]);
    expect(issues[0]!.suggestion).toBe('Use `z.email()`.');
  });

  it('reports enum, format and constraint differences with severities', () => {
    const issues = compare(
      ValidUser.extend({
        email: z.string(),
        name: z.string().max(20).optional(),
        role: z.enum(['admin', 'guest']),
        tags: z.array(z.string()).min(1).optional(),
      }),
      User,
    );
    expect(codes(issues)).toEqual([
      'warning:FORMAT_MISMATCH:email',
      'error:CONSTRAINT_MISMATCH:name',
      'error:ENUM_MISMATCH:role',
      'warning:ENUM_MISMATCH:role',
      'error:CONSTRAINT_MISMATCH:tags',
    ]);
  });

  it('treats looser constraints as warnings', () => {
    const issues = compare(ValidUser.extend({ name: z.string().optional() }), User);
    expect(codes(issues)).toEqual(['warning:CONSTRAINT_MISMATCH:name']);
    expect(issues[0]!.suggestion).toBe('Add `.max(50)`.');
  });

  it('treats equivalent inclusive and exclusive integer bounds as equal', () => {
    expect(compare(z.int().positive(), { type: 'integer', minimum: 1 })).toEqual([]);
    expect(compare(z.int().min(1), { type: 'integer', exclusiveMinimum: 0 })).toEqual([]);
    expect(compare(z.int().lt(11), { type: 'integer', maximum: 10 })).toEqual([]);
  });

  it('compares inclusive and exclusive bounds as one bound with one severity', () => {
    // .gt(0) rejects 0, which the contract allows: stricter.
    const stricter = compare(z.number().gt(0), { type: 'number', minimum: 0 });
    expect(codes(stricter)).toEqual(['error:CONSTRAINT_MISMATCH:']);
    expect(stricter[0]!.suggestion).toBe('Use `.min(0)`.');

    // .min(0) accepts 0, which the contract forbids: looser.
    const looser = compare(z.number().min(0), { type: 'number', exclusiveMinimum: 0 });
    expect(codes(looser)).toEqual(['warning:CONSTRAINT_MISMATCH:']);
    expect(looser[0]!.suggestion).toBe('Use `.gt(0)`.');
  });

  it('applies readOnly / writeOnly rules per mode', () => {
    const request = ValidUser.omit({ id: true });
    expect(compare(request, User, { mode: 'request', io: 'input' })).toEqual([]);
    // readOnly id required in a request schema: clients cannot send it → rejects valid requests
    expect(codes(compare(ValidUser, User, { mode: 'request' }))).toEqual(['error:EXTRA_FIELD:id']);
    const response = ValidUser.omit({ password: true });
    expect(compare(response, User, { mode: 'response' })).toEqual([]);
    // component mode tolerates both
    expect(compare(request, User)).toEqual([]);
    expect(compare(response, User)).toEqual([]);
  });

  it('resolves $refs, allOf and nested arrays against the document', () => {
    const document: OpenApiDocument = {
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      components: {
        schemas: {
          Base: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
          Item: {
            allOf: [
              { $ref: '#/components/schemas/Base' },
              { type: 'object', properties: { qty: { type: 'integer', minimum: 1 } } },
            ],
          },
          Cart: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Item' } } } },
        },
      },
    };
    const Cart = z.object({ items: z.array(z.object({ id: z.string(), qty: z.number() })).optional() });
    // qty: optional + integer in the contract, required + number in Zod
    expect(codes(compare(Cart, { $ref: '#/components/schemas/Cart' }, { document }))).toEqual([
      'error:OPTIONALITY_MISMATCH:items[].qty',
      'error:TYPE_MISMATCH:items[].qty',
    ]);
  });

  it('handles recursive schemas without looping', () => {
    const document: OpenApiDocument = {
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      components: {
        schemas: {
          Node: {
            type: 'object',
            required: ['value'],
            properties: { value: { type: 'string' }, next: { $ref: '#/components/schemas/Node' } },
          },
        },
      },
    };
    const Node = z.object({
      value: z.number(),
      get next() {
        return Node.optional();
      },
    });
    expect(codes(compare(Node, { $ref: '#/components/schemas/Node' }, { document }))).toEqual(['error:TYPE_MISMATCH:value']);
  });

  it('compares unions variant by variant', () => {
    const contract: SchemaObject = {
      oneOf: [
        { type: 'object', required: ['kind', 'r'], properties: { kind: { const: 'circle' }, r: { type: 'number' } } },
        { type: 'object', required: ['kind', 'w'], properties: { kind: { const: 'square' }, w: { type: 'number' } } },
      ],
    };
    const good = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('circle'), r: z.number() }),
      z.object({ kind: z.literal('square'), w: z.number() }),
    ]);
    expect(compare(good, contract)).toEqual([]);
    const bad = z.union([z.object({ kind: z.literal('circle'), r: z.string() }), z.object({ kind: z.literal('square'), w: z.number() })]);
    expect(codes(compare(bad, contract))).toEqual(['error:TYPE_MISMATCH:r<variant 0>']);
    expect(codes(compare(z.object({ kind: z.string() }), contract))).toEqual(['error:TYPE_MISMATCH:']);
  });

  it('ignores Zod-internal details: safe-int bounds, format regexes, closed objects', () => {
    const contract: SchemaObject = {
      type: 'object',
      required: ['n', 'id'],
      properties: { n: { type: 'integer' }, id: { type: 'string', format: 'uuid' } },
    };
    expect(compare(z.strictObject({ n: z.int(), id: z.uuid() }), contract)).toEqual([]);
  });

  it('warns when Zod accepts anything', () => {
    expect(codes(compare(z.object({ a: z.any() }), { type: 'object', required: ['a'], properties: { a: { type: 'string' } } }))).toEqual([
      'warning:UNCOMPARABLE:a',
    ]);
  });
});
