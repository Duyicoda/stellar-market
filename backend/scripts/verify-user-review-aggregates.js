const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { PrismaClient } = require("@prisma/client");

dotenv.config();

const { logger, installRequestIdConsolePatch } = require("../src/lib/logger");
installRequestIdConsolePatch();

const prisma = new PrismaClient();
const queryPath = path.join(__dirname, "./verify-user-review-aggregates.sql");
const query = fs.readFileSync(queryPath, "utf8");

async function main () {
    const rows = await prisma.$queryRawUnsafe(query);

    if (!Array.isArray(rows) || rows.length === 0) {
        logger.info("No review aggregate mismatches found.");
        return;
    }

    logger.error({ count: rows.length }, `Found ${rows.length} review aggregate mismatches.`);
    logger.info({ rows }, "mismatched_rows");
    process.exitCode = 1;
}

main()
    .catch((error) => {
        logger.error({ err: error }, "Failed to verify user review aggregates");
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
