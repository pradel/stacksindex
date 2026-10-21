import pg from "pg";

import {
  newTestRunPrefix,
  TEST_DATABASE_PREFIX,
  TEST_POSTGRES_URL,
  TEST_RUN_PREFIX_ENV,
} from "./fresh-database.ts";

/**
 * Age past which another run's database counts as a leftover. A full run takes
 * about a minute, so anything older belongs to a run that crashed or was killed
 * before its teardown.
 */
const STALE_AFTER_SECONDS = 60 * 60;

const CREATED_AT = new RegExp(`^${TEST_DATABASE_PREFIX}(\\d+)_`, "u");

/** Drops the test databases whose name `shouldDrop` accepts. */
const dropTestDatabases = async (
  adminUrl: string,
  shouldDrop: (name: string) => boolean,
): Promise<void> => {
  const client = new pg.Client({ connectionString: adminUrl });

  await client.connect();

  try {
    const { rows } = await client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE starts_with(datname, $1)",
      [TEST_DATABASE_PREFIX],
    );

    for (const { datname } of rows.filter((row) => shouldDrop(row.datname))) {
      await client.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    }
  } finally {
    await client.end();
  }
};

const isStale = (name: string, nowSeconds: number): boolean => {
  const createdAt = CREATED_AT.exec(name)?.[1];

  return createdAt !== undefined && nowSeconds - Number(createdAt) > STALE_AFTER_SECONDS;
};

/**
 * With `STACKSINDEX_TEST_POSTGRES_URL` set, gives this run its own database
 * name prefix. Before the tests it drops leftovers older than an hour, so runs
 * sharing the server never drop each other's databases; after them it drops
 * the databases this run created.
 */
export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  if (TEST_POSTGRES_URL === undefined) {
    return undefined;
  }

  const adminUrl = TEST_POSTGRES_URL;
  const runPrefix = newTestRunPrefix();
  const nowSeconds = Math.floor(Date.now() / 1000);

  await dropTestDatabases(adminUrl, (name) => isStale(name, nowSeconds));

  // oxlint-disable-next-line node/no-process-env -- read by the test workers
  process.env[TEST_RUN_PREFIX_ENV] = runPrefix;

  return () => dropTestDatabases(adminUrl, (name) => name.startsWith(runPrefix));
}
