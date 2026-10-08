import { Contract, Address } from "@stellar/stellar-sdk";
import { config } from "../config";
import { ContractService } from "./contract.service";
import { logger } from "../lib/logger";

export interface OnChainReputation {
  total_score: bigint;
  total_weight: bigint;
  review_count: number;
}

export class ReputationService {
  /**
   * Fetches the on-chain reputation for a given wallet address.
   */
  static async getReputation(walletAddress: string): Promise<OnChainReputation | null> {
    const contractId = config.stellar.reputationContractId;
    if (!contractId) {
      logger.warn("REPUTATION_CONTRACT_ID not configured");
      return null;
    }

    try {
      const contract = new Contract(contractId);
      const native = await ContractService.simulateContractRead(
        contract.call("get_reputation", new Address(walletAddress).toScVal())
      );

      // result is a native object from scValToNative
      const rep = native as {
        total_score?: number | bigint;
        total_weight?: number | bigint;
        review_count?: number | bigint;
      };
      return {
        total_score: BigInt(rep.total_score ?? 0),
        total_weight: BigInt(rep.total_weight ?? 0),
        review_count: Number(rep.review_count ?? 0),
      };
    } catch (error) {
      // If user not found on-chain, contract might throw/revert
      logger.warn(
        { walletAddress, err: error instanceof Error ? error.message : error },
        `Reputation not found for ${walletAddress}`,
      );
      return null;
    }
  }
}
