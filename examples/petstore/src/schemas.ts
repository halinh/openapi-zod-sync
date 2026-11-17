/**
 * Hand-written Zod schemas for the Petstore API — the kind of file that slowly
 * drifts away from openapi.yaml. Each drift below is intentional and is
 * detected by `openapi-zod-sync check`.
 */
import { z } from 'zod';

export const PetStatusSchema = z.enum(['available', 'sold']); // DRIFT: "pending" is missing

export const OwnerSchema = z.object({
  email: z.string(), // DRIFT: contract says format: email
  phone: z.string().optional(),
});

export const PetSchema = z.object({
  id: z.int().min(1),
  name: z.string().min(1).max(30), // DRIFT: contract maxLength is 50
  status: PetStatusSchema,
  tags: z.array(z.string()).max(10).optional(),
  birthDate: z.iso.date().optional(),
  weightKg: z.number().positive(), // DRIFT: optional in the contract
  owner: OwnerSchema.optional(), // DRIFT: contract allows null
  nickname: z.string().optional(), // DRIFT: not in the contract
});

// Request body for POST /pets, matched to createPet.body through the config mapping.
export const NewPetSchema = PetSchema.omit({ id: true });

export const ListPetsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: PetStatusSchema.optional(),
  // DRIFT: includeArchived is missing
});

export const CategorySchema: z.ZodType<{ name: string; children?: unknown[] }> = z.object({
  name: z.string(),
  get children() {
    return z.array(CategorySchema).optional();
  },
});
