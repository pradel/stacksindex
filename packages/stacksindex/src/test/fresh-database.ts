import { randomBytes } from "node:crypto";

import pg from "pg";

import { type Database, pglite, postgres } from "../database/index.ts";

/**
 * Admin URL of a Postgres server to run the database tests against instead of
 * PGlite, e.g. `postgres://postgres:postgres@localhost:5432/postgres`. Each
 * test database is a new Postgres database created through it.
 */
// oxlint-disable-next-line node/no-process-env -- test-only switch, never read by the library
export const TEST_POSTGRES_URL = process.env.STACKSINDEX_TEST_POSTGRES_URL;

/**
 * Prefix of every database the tests create. A full name is
 * `stacksindex_test_<epoch seconds>_<run id>_<database id>`: the run part lets a
 * run drop only its own databases, the timestamp lets a later run tell stale
 * leftovers from a run still in progress.
 */
export const TEST_DATABASE_PREFIX = "stacksindex_test_";

/** Env var through which the global setup hands the current run's prefix to the test workers. */
export const TEST_RUN_PREFIX_ENV = "STACKSINDEX_TEST_RUN_PREFIX";

/** A new run's database name prefix: `stacksindex_test_<epoch seconds>_<run id>_`. */
export const newTestRunPrefix = (): string =>
  `${TEST_DATABASE_PREFIX}${Math.floor(Date.now() / 1000)}_${randomBytes(4).toString("hex")}_`;

const createPostgresDatabase = async (adminUrl: string): Promise<Database> => {
  // oxlint-disable-next-line node/no-process-env -- set by the test global setup
  const runPrefix = process.env[TEST_RUN_PREFIX_ENV];

  if (runPrefix === undefined) {
    throw new Error(
      `${TEST_RUN_PREFIX_ENV} is not set: run the tests through Vitest, whose global setup sets it.`,
    );
  }

  const name = `${runPrefix}${randomBytes(6).toString("hex")}`;
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
