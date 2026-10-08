-- Unify admin-action and security-event audit logging into one append-only,
-- hash-chained table (issue #875).

-- 1. Category discriminator for the unified table.
CREATE TYPE "AuditCategory" AS ENUM ('ADMIN_ACTION', 'SECURITY_EVENT');

-- 2. The old adminId FK cannot represent system/security actors (e.g. the
--    "system" virus-scanner), so drop it in favour of a free-form actorId.
ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_adminId_fkey";

-- 3. New columns, added nullable so existing rows can be backfilled first.
ALTER TABLE "AuditLog" ADD COLUMN "sequence" INTEGER;
ALTER TABLE "AuditLog" ADD COLUMN "category" "AuditCategory";
ALTER TABLE "AuditLog" ADD COLUMN "actorId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "ipAddress" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "prevHash" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "hash" TEXT;

-- 4. Backfill existing rows. They predate the hash chain, so they are marked
--    with the sentinel hash 'legacy' and a NULL prevHash; verifyChain() treats
--    such a leading run as unverifiable-by-design and starts the cryptographic
--    chain at the first row written after this migration. Sequence is still
--    assigned contiguously so that deleting a legacy row remains detectable as
--    a gap.
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "timestamp" ASC, id ASC) AS rn
  FROM "AuditLog"
)
UPDATE "AuditLog" a
SET "sequence" = o.rn,
    "category" = 'ADMIN_ACTION',
    "actorId"  = a."adminId",
    "hash"     = 'legacy'
FROM ordered o
WHERE a.id = o.id;

-- 5. Enforce constraints now that data is populated. target becomes optional
--    because security events (e.g. VIRUS_SCANNER_INIT_FAILED) have no target.
ALTER TABLE "AuditLog" ALTER COLUMN "sequence" SET NOT NULL;
ALTER TABLE "AuditLog" ALTER COLUMN "category" SET NOT NULL;
ALTER TABLE "AuditLog" ALTER COLUMN "hash" SET NOT NULL;
ALTER TABLE "AuditLog" ALTER COLUMN "target" DROP NOT NULL;

-- 6. The old adminId column is superseded by the free-form actorId.
ALTER TABLE "AuditLog" DROP COLUMN "adminId";

-- 7. Indexes.
CREATE UNIQUE INDEX "AuditLog_sequence_key" ON "AuditLog"("sequence");
CREATE INDEX "AuditLog_category_idx" ON "AuditLog"("category");
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");
CREATE INDEX "AuditLog_timestamp_idx" ON "AuditLog"("timestamp");
