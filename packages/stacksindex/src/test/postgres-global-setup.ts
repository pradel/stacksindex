import pg from "pg";

import { TEST_DATABASE_PREFIX, TEST_POSTGRES_URL } from "./fresh-database.ts";

/** Drops every database the tests created on the Postgres server. */
const dropTestDatabases = async (adminUrl: string): Promise<void> => {
  const client = new pg.Client({ connectionString: adminUrl });

  await client.connect();

  try {
    const { rows } = await client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE starts_with(datname, $1)",
      [TEST_DATABASE_PREFIX],
    );

    for (const { datname } of rows) {
      await client.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    }
  } finally {
    await client.end();
  }
};

/**
 * With `STACKSINDEX_TEST_POSTGRES_URL` set, drops the databases a previous run
 * left behind before the tests, and the ones this run created after them.
 */
export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  if (TEST_POSTGRES_URL === undefined) {
    return undefined;
  }

  const adminUrl = TEST_POSTGRES_URL;

  await dropTestDatabases(adminUrl);

  return () => dropTestDatabases(adminUrl);
}
