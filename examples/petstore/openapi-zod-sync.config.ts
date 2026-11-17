import { defineConfig } from '../../src/index.js'; // in your project: from 'openapi-zod-sync'

export default defineConfig({
  spec: './openapi.yaml',
  generate: {
    output: './generated/schemas.ts',
  },
  check: {
    schemas: ['./src/**/*.ts'],
    // Names that do not follow the conventions are mapped explicitly.
    mapping: {
      'createPet.body': 'NewPetSchema',
    },
    failOn: 'error',
  },
});
