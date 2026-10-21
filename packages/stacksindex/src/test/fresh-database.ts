import { randomUUID } from "node:crypto";

import pg from "pg";

import { type Database, pglite, postgres } from "../database/index.ts";

/**
 * Admin URL of a Postgres server to run the database tests against instead of
 * PGlite, e.g. `postgres://postgres:postgres@localhost:5432/postgres`. Each
 * test database is a new Postgres database created through it.
 */
// oxlint-disable-next-line node/no-process-env -- test-only switch, never read by the library
export const TEST_POSTGRES_URL = process.env.STACKSINDEX_TEST_POSTGRES_URL;

/** Prefix of every database the tests create, so a teardown can drop them. */
export const TEST_DATABASE_PREFIX = "stacksindex_test_";

const createPostgresDatabase = async (adminUrl: string): Promise<Database> => {
  const name = `${TEST_DATABASE_PREFIX}${randomUUID().replaceAll("-", "")}`;
  const client = new pg.Client({ connectionString: adminUrl });

  await client.connect();

  try {
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;

  return postgres(url.toString());
};

/**
 * An empty database for one test: in-memory PGlite, or a new Postgres database
 * when `STACKSINDEX_TEST_POSTGRES_URL` is set.
 */
export const freshDatabase = (): Promise<Database> =>
  TEST_POSTGRES_URL === undefined
    ? Promise.resolve(pglite())
    : createPostgresDatabase(TEST_POSTGRES_URL);

/**
 * An empty database that keeps its data when reopened: PGlite in `directory`,
 * or a new Postgres database when `STACKSINDEX_TEST_POSTGRES_URL` is set.
 */
export const persistentDatabase = (directory: string): Promise<Database> =>
  TEST_POSTGRES_URL === undefined
    ? Promise.resolve(pglite(directory))
    : createPostgresDatabase(TEST_POSTGRES_URL);
