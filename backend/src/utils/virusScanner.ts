import NodeClam from "clamscan";
import fs from "fs";
import { auditLogger } from "./auditLogger";
import { logger } from "../lib/logger";

let clamScanInstance: NodeClam | null = null;
let clamAvailable = false;

// Feature flag: skip scanning if ClamAV is not installed (for CI/dev environments)
const ENABLE_VIRUS_SCAN = process.env.ENABLE_VIRUS_SCAN !== "false";

/**
 * Initialize ClamAV scanner
 */
export async function initializeVirusScanner(): Promise<void> {
  if (!ENABLE_VIRUS_SCAN) {
    logger.info("[VirusScanner] Virus scanning disabled via ENABLE_VIRUS_SCAN=false");
    return;
  }

  try {
    clamScanInstance = await new NodeClam().init({
      removeInfected: false, // We'll handle file deletion manually
      quarantineInfected: false,
      scanLog: null,
      debugMode: false,
      clamdscan: {
        socket: process.env.CLAMAV_SOCKET || "/var/run/clamav/clamd.sock",
        host: process.env.CLAMAV_HOST || "localhost",
        port: parseInt(process.env.CLAMAV_PORT || "3310"),
        timeout: 60000,
        localFallback: true,
      },
      preference: "clamdscan", // Prefer daemon for better performance
    });

    // Test connection
    const version = await clamScanInstance.getVersion();
    clamAvailable = true;
    logger.info(`[VirusScanner] ClamAV initialized successfully. Version: ${version}`);
  } catch (error) {
    clamAvailable = false;
    const errMessage = error instanceof Error ? error.message : String(error);
    logger.warn(
      { err: errMessage },
      `[VirusScanner] ClamAV initialization failed. Virus scanning will be skipped.`,
    );
    auditLogger.log({
      action: "VIRUS_SCANNER_INIT_FAILED",
      userId: "system",
      details: { error: errMessage },
      ipAddress: "localhost",
    });
  }
}

export interface ScanResult {
  isInfected: boolean;
  viruses?: string[];
  error?: string;
  skipped?: boolean;
}

/**
 * Scan a file for viruses
 * @param filePath - Absolute path to the file
 * @returns ScanResult
 */
export async function scanFile(filePath: string): Promise<ScanResult> {
  // If scanning is disabled or ClamAV is not available, skip gracefully
  if (!ENABLE_VIRUS_SCAN || !clamAvailable) {
    return {
      isInfected: false,
      skipped: true,
    };
  }

  // Verify file exists
  if (!fs.existsSync(filePath)) {
    return {
      isInfected: false,
      error: "File not found",
    };
  }

  try {
    if (!clamScanInstance) {
      // Attempt to reinitialize
      await initializeVirusScanner();
      if (!clamScanInstance) {
        return {
          isInfected: false,
          skipped: true,
          error: "ClamAV not available",
        };
      }
    }

    const { isInfected, viruses } = await clamScanInstance.isInfected(filePath);

    if (isInfected && viruses && viruses.length > 0) {
      auditLogger.log({
        action: "VIRUS_DETECTED",
        userId: "system",
        details: {
          filePath,
          viruses,
        },
        ipAddress: "localhost",
      });

      return {
        isInfected: true,
        viruses,
      };
    }

    return {
      isInfected: false,
    };
  } catch (error) {
    // Log error but don't fail the upload - degrade gracefully
    const errMessage = error instanceof Error ? error.message : String(error);
    logger.error({ err: errMessage, filePath }, `[VirusScanner] Scan error for ${filePath}`);
    auditLogger.log({
      action: "VIRUS_SCAN_ERROR",
      userId: "system",
      details: {
        filePath,
        error: errMessage,
      },
      ipAddress: "localhost",
    });

    return {
      isInfected: false,
      error: errMessage,
      skipped: true,
    };
  }
}

/**
 * Check if virus scanning is available
 */
export function isVirusScanningAvailable(): boolean {
  return ENABLE_VIRUS_SCAN && clamAvailable;
}
