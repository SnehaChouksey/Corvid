import { defineConfig } from 'drizzle-kit';

// Migrations are owned by drizzle-kit (Better Auth's programmatic migration doesn't support
// Drizzle). `db:generate` writes SQL from the schema; `db:migrate` applies it.
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://corvid:corvid@localhost:5432/corvid',
  },
});
