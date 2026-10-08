import Image from "next/image";
import Avatar from "@/components/Avatar.server";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api/v1";

type Props = { userPromise: Promise<any> };

export default async function ProfileHeader({ userPromise }: Props) {
  const user = await userPromise;
  return (
    <header className="flex flex-col sm:flex-row gap-6 items-start mb-10">
      <Avatar
        src={user.avatarUrl}
        alt={user.username}
        size={112}
        priority
        unoptimized
        className="flex-shrink-0 border-4 border-theme-card"
      />

      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <h1 className="text-3xl font-bold text-theme-heading truncate">{user.username}</h1>
          <span className="text-xs font-medium text-stellar-purple bg-stellar-purple/10 px-2.5 py-1 rounded-full border border-stellar-purple/20">
            {user.role}
          </span>
        </div>

        <p className="text-base text-theme-text mb-4 max-w-2xl">{user.bio || "No bio provided."}</p>

        {user.skills?.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            {user.skills.map((s: string, i: number) => (
              <span key={i} className="px-2.5 py-1 bg-theme-card border border-theme-border rounded-full text-xs text-theme-text">
                {s}
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-5 text-sm text-theme-text">
          <div className="flex items-center gap-1.5">
            <div className="text-theme-warning font-semibold text-xl">{(user.averageRating || 0).toFixed(1)}/5</div>
            <div className="ml-2 text-theme-text/60">({user.reviewCount || 0} reviews)</div>
          </div>
          <div className="flex items-center gap-1.5">Member since {new Date(user.createdAt).toLocaleDateString()}</div>
        </div>
      </div>
    </header>
  );
}
