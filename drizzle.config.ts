import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://lawkku_freshstart23:lawkku_freshstart23@localhost:5432/lawkku_freshstart23",
  },
});
