import { PrismaClient } from "@prisma/client";

export class MessageValidationError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "MessageValidationError";
    this.status = status;
  }
}

export async function validateMessageSendAuthorization({
  senderId,
  receiverId,
  jobId,
  prismaClient,
}: {
  senderId: string;
  receiverId: string;
  jobId?: string | null;
  prismaClient: PrismaClient;
}): Promise<void> {
  if (senderId === receiverId) {
    throw new MessageValidationError(400, "Cannot send a message to yourself.");
  }

  const receiver = await prismaClient.user.findUnique({ where: { id: receiverId } });
  if (!receiver) {
    throw new MessageValidationError(404, "Receiver not found.");
  }

  if (jobId) {
    const job = await prismaClient.job.findUnique({ where: { id: jobId } });
    if (!job) {
      throw new MessageValidationError(404, "Job not found.");
    }

    if (job.clientId !== senderId && job.freelancerId !== senderId) {
      throw new MessageValidationError(
        403,
        "Not authorized to send messages for this job.",
      );
    }
  }
}
