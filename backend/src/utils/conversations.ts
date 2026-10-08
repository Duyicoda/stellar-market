type UserSummary = { id: string; username: string; avatarUrl: string | null };

interface ConversationMessage {
  senderId: string;
  receiverId: string;
  jobId: string | null;
  read: boolean;
  sender: UserSummary;
  receiver: UserSummary;
  job?: { id: string; title: string } | null;
}

/**
 * - "partner": one conversation per counterpart user, merged across jobs
 *   (used by GET /messages/conversations).
 * - "partner-and-job": one conversation per counterpart user per job
 *   (used by the default GET /messages view).
 */
export type ConversationGrouping = "partner" | "partner-and-job";

/**
 * Builds conversation summaries from messages sorted newest-first.
 * The first message seen for a group is its lastMessage.
 */
export function buildConversationSummaries<M extends ConversationMessage>(
  messages: M[],
  userId: string,
  { groupBy }: { groupBy: ConversationGrouping },
) {
  const map = new Map<
    string,
    {
      id: string;
      otherUser: UserSummary;
      job: M["job"] | null;
      lastMessage: M;
      unreadCount: number;
    }
  >();

  for (const msg of messages) {
    const otherUser = msg.senderId === userId ? msg.receiver : msg.sender;
    const key =
      groupBy === "partner"
        ? otherUser.id
        : `${otherUser.id}-${msg.jobId || "no-job"}`;

    let convo = map.get(key);
    if (!convo) {
      convo = {
        id: key,
        otherUser,
        job: msg.job ?? null,
        lastMessage: msg,
        unreadCount: 0,
      };
      map.set(key, convo);
    }

    if (msg.receiverId === userId && !msg.read) {
      convo.unreadCount += 1;
    }
  }

  return Array.from(map.values());
}
