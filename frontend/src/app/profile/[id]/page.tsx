import { Metadata } from "next";
import ProfileClient from "./ProfileClient";
import { generateProfileMetadata } from "@/components/SEOMetadata";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api/v1";

async function getProfile(id: string) {
  try {
    const res = await fetch(`${API_URL}/users/${id}`, {
      next: { revalidate: 60 } as RequestInit["next"],
    });
    if (!res.ok) return null;
    return res.json();
  } catch (error) {
    console.error("Error fetching profile for metadata:", error);
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const profile = await getProfile(id);
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://stellarmarket.io";
  const canonical = `${baseUrl}/profile/${id}`;

  if (!profile) {
    return {
      title: "Profile Not Found | StellarMarket",
      description: "The requested profile could not be found.",
      alternates: { canonical },
    };
  }

  return generateProfileMetadata({
    name: profile.username,
    bio: profile.bio || `Check out ${profile.username}'s profile on StellarMarket.`,
    avatar: profile.avatarUrl,
    url: canonical,
  });
}

export default function ProfilePage() {
  return <ProfileClient />;
}
