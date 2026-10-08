import { cache } from "react";
import { Metadata } from "next";
import { generateJobMetadata } from "@/components/SEOMetadata";
import JobDetailClient from "./JobDetailClient";
import type { Job } from "@/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api/v1";

const getJob = cache(async (id: string): Promise<Job | null> => {
  try {
    const res = await fetch(`${API_URL}/jobs/${id}`, {
      next: { revalidate: 60 } as RequestInit["next"],
    });
    if (!res.ok) return null;
    return res.json();
  } catch (error) {
    console.error("Error fetching job:", error);
    return null;
  }
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const job = await getJob(id);
  if (!job) {
    return {
      title: "Job Not Found | StellarMarket",
      description: "The requested job could not be found.",
    };
  }

  return generateJobMetadata({
    title: job.title,
    description: job.description || "Check out this job on StellarMarket",
    id,
  });
}

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const job = await getJob(id);
  return <JobDetailClient initialJob={job} />;
}
