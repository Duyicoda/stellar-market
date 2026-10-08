/**
 * One-time script to normalise free-text job categories to their closest
 * canonical value. Run once after deploying the category validation gate.
 *
 * Usage:
 *   npx ts-node scripts/normalize-job-categories.ts
 *
 * Dry-run (no DB writes):
 *   DRY_RUN=true npx ts-node scripts/normalize-job-categories.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const VALID_CATEGORIES = [
  "Frontend",
  "Backend",
  "Smart Contract",
  "Design",
  "Mobile",
  "Documentation",
  "DevOps",
];

function findClosestCanonical(raw: string): string | null {
  const normalised = raw.trim().toLowerCase().replace(/[-_]/g, " ");
  return (
    VALID_CATEGORIES.find((c) => c.toLowerCase() === normalised) ?? null
  );
}

async function main() {
  const dryRun = process.env.DRY_RUN === "true";

  const jobs = await prisma.job.findMany({
    select: { id: true, category: true },
  });

  let updated = 0;
  let skipped = 0;

  for (const job of jobs) {
    const canonical = findClosestCanonical(job.category);
    if (!canonical || canonical === job.category) {
      skipped++;
      continue;
    }

    console.log(`[${job.id}] "${job.category}" → "${canonical}"`);

    if (!dryRun) {
      await prisma.job.update({
        where: { id: job.id },
        data: { category: canonical },
      });
    }

    updated++;
  }

  console.log(
    `\nDone. Updated: ${updated}, Skipped (already canonical or no match): ${skipped}${dryRun ? " [DRY RUN]" : ""}`,
  );
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
