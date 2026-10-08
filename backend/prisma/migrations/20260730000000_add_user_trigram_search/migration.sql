-- Migration: Enable pg_trgm extension and add GIN trigram indexes on User columns
-- for freelancer search performance. Follows the same pattern as
-- 20260425000000_add_job_search_and_token_filter/migration.sql.

-- 1. Enable pg_trgm extension (idempotent)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. GIN trigram index on username for fast ILIKE '%token%' search
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_username_trgm_idx"
  ON "User" USING GIN ("username" gin_trgm_ops);

-- 3. GIN trigram index on bio for fast ILIKE '%token%' search
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_bio_trgm_idx"
  ON "User" USING GIN ("bio" gin_trgm_ops);

-- 4. GIN trigram index on skills (converted to space-separated text) for fast
--    ILIKE skill filtering. The expression index allows ILIKE queries on
--    array_to_string("skills", ' ') to use a GIN trigram scan instead of
--    unnest + sequential scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_skills_trgm_idx"
  ON "User" USING GIN (array_to_string("skills", ' ') gin_trgm_ops);
