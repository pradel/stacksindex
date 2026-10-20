import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./src/schema.ts",
  dialect: "postgresql",
  driver: "pglite",
  dbCredentials: {
    url: "./data/indexer.db",
  },
  // The `stacksindex` schema belongs to the indexer.
  schemaFilter: ["public"],
});
