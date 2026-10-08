export const JOB_CATEGORIES = [
  "Frontend",
  "Backend",
  "Smart Contract",
  "Design",
  "Mobile",
  "Documentation",
  "DevOps",
] as const;

export type JobCategory = (typeof JOB_CATEGORIES)[number];
