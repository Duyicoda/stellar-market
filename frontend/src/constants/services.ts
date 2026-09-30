// Single source of truth for service categories, shared by the "Post a
// Service" creation form and the /services browse/filter pages (and their
// category landing pages) so a listing created under any category is
// actually filterable and reachable (issue #1344).
export const SERVICE_CATEGORIES = [
  "Frontend",
  "Backend",
  "Smart Contract",
  "Design",
  "Mobile",
  "Documentation",
] as const;
