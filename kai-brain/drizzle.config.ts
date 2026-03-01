import { defineConfig } from 'drizzle-kit';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, '.env') });
loadEnv({ path: path.resolve(__dirname, '.env.local'), override: true });

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  tablesFilter: ['ava_*', 'kai_*'],
  verbose: true,
  strict: true,
});
