DO $$
BEGIN
  -- Stored blocks have no index block hash and the API is unreachable from SQL:
  -- refuse to migrate instead of storing blocks that read-only calls cannot pin to.
  IF EXISTS (SELECT 1 FROM "blocks") THEN
    RAISE EXCEPTION 'stacksindex: blocks now store their index block hash. Re-sync from an empty indexer database (and reset the tables your handlers write to).';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "indexBlockHash" varchar(66) NOT NULL;
