"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { MessageSquare, Search, User, Briefcase } from "lucide-react";
import axios from "axios";
import { Conversation } from "@/types";
import Image from "next/image";
import { useAuth } from "@/context/AuthContext";
import { useDelay } from "@/hooks/useDelay";
import MessageSkeleton from "@/components/skeletons/MessageSkeleton";
import Avatar from "@/components/Avatar";

export default function InboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxPageContent />
    </Suspense>
  );
}

function InboxPageContent() {
  const { token } = useAuth();
  const searchParams = useSearchParams();
  const router = useRouter();
  const jobId = searchParams.get("jobId");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  const ready = useDelay();

  useEffect(() => {
    const fetchConversations = async () => {
      try {
        if (!token) return;
        setLoading(true);
        const response = await axios.get(
          `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api/v1"}/messages`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        setConversations(response.data);

        // Auto-navigate to conversation matching jobId if provided
        if (jobId) {
          const matchingConversation = response.data.find(
            (conv: Conversation) => conv.job?.id === jobId,
          );
          if (matchingConversation) {
            router.replace(`/messages/${matchingConversation.id}`);
          }
        }
      } catch (err) {
        console.error("Fetch conversations error:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchConversations();
  }, [token, jobId, router]);

  const filteredConversations = conversations.filter(
    (conv) =>
      conv.otherUser.username
        .toLowerCase()
        .includes(searchQuery.toLowerCase()) ||
      conv.job?.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      conv.lastMessage.content
        .toLowerCase()
        .includes(searchQuery.toLowerCase()),
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8">
        <div>
          <h1 className="text-3xl font-bold text-theme-heading mb-2">
            Messages
          </h1>
          <p className="text-theme-text">
            Communicate with clients and freelancers
          </p>
        </div>
        <div className="relative w-full md:w-96">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-text"
            size={18}
          />
          <input
            type="text"
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="input w-full pl-10"
          />
        </div>
      </div>

      <div className="space-y-4">
        {loading && ready ? (
          Array.from({ length: 3 }).map((_, i) => (
            <MessageSkeleton key={i} />
          ))
        ) : loading ? null : filteredConversations.length > 0 ? (
          filteredConversations.map((conv) => (
            <Link key={conv.id} href={`/messages/${conv.id}`}>
              <div className="card hover:border-stellar-blue/30 transition-all group flex items-start gap-4 cursor-pointer relative">
                <Avatar
                  src={conv.otherUser.avatarUrl}
                  alt={conv.otherUser.username}
                  size={48}
                  className="flex-shrink-0 border border-theme-border"
                />

                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-start mb-1">
                    <h3 className="font-semibold text-theme-heading group-hover:text-stellar-blue transition-colors">
                      {conv.otherUser.username}
                    </h3>
                    <span className="text-[10px] text-theme-text uppercase font-medium">
                      {new Date(
                        conv.lastMessage.createdAt,
                      ).toLocaleDateString()}
                    </span>
                  </div>

                  {conv.job && (
                    <div className="flex items-center gap-1.5 text-xs text-stellar-purple mb-2">
                      <Briefcase size={12} />
                      <span className="truncate">{conv.job.title}</span>
                    </div>
                  )}

                  <p className="text-sm text-theme-text truncate pr-8">
                    {conv.lastMessage.senderId === conv.otherUser.id
                      ? ""
                      : "You: "}
                    {conv.lastMessage.content}
                  </p>
                </div>

                {conv.unreadCount > 0 && (
                  <div className="absolute right-6 top-1/2 -translate-y-1/2 w-5 h-5 bg-stellar-blue rounded-full flex items-center justify-center text-[10px] font-bold text-white shadow-lg">
                    {conv.unreadCount}
                  </div>
                )}
              </div>
            </Link>
          ))
        ) : (
          <div className="card text-center py-20 flex flex-col items-center">
            <MessageSquare size={48} className="text-theme-border mb-4" />
            <h3 className="text-xl font-semibold text-theme-heading mb-2">
              No conversations found
            </h3>
            <p className="text-theme-text max-w-sm">
              {searchQuery
                ? "No messages match your search. Try another query."
                : "When you start a conversation about a job, it will appear here."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
