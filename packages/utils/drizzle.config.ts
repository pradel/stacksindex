import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./src/sync-store/schema.ts",
  dialect: "postgresql",
});
