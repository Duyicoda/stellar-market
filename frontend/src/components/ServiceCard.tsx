import Link from "next/link";
import { Star, DollarSign, Tag, Clock } from "lucide-react";
import { ServiceListing } from "@/types";
import Avatar from "@/components/Avatar";

interface ServiceCardProps {
  service: ServiceListing;
}

export default function ServiceCard({ service }: ServiceCardProps) {
  // Aggregate rating would be calculated from reviewsReceived, 
  // but for simplicity we assume a default or use averageRating if available in User type.
  const averageRating = service.freelancer.averageRating || 0;
  const reviewCount = service.freelancer.reviewCount || 0;

  return (
    <Link href={`/services/${service.id}`}>
      <div className="card hover:border-stellar-blue/50 transition-all duration-200 cursor-pointer h-full flex flex-col">
        <div className="flex items-start justify-between mb-3">
          <span className="text-xs font-medium text-stellar-blue bg-stellar-blue/10 px-2 py-1 rounded">
            {service.category}
          </span>
          <div className="flex items-center gap-1 text-yellow-500">
            <Star size={14} fill="currentColor" />
            <span className="text-xs font-semibold">{averageRating.toFixed(1)}</span>
            <span className="text-xs text-theme-text">({reviewCount})</span>
          </div>
        </div>

        <h3 className="text-lg font-semibold text-theme-heading mb-2 line-clamp-1">
          {service.title}
        </h3>

        <p className="text-sm text-theme-text mb-4 line-clamp-2 flex-grow">
          {service.description}
        </p>

        <div className="flex items-center gap-4 text-sm text-theme-text mb-4">
          <div className="flex items-center gap-1">
            <DollarSign size={14} className="text-theme-success" />
            <span className="font-semibold text-theme-heading">{service.price.toLocaleString()} XLM</span>
          </div>
          <div className="flex items-center gap-1">
            <Clock size={14} />
            <span>{new Date(service.createdAt).toLocaleDateString()}</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-1 mb-4">
          {service.skills.slice(0, 3).map((skill) => (
            <span key={skill} className="text-[10px] bg-theme-border/30 text-theme-text px-2 py-0.5 rounded flex items-center gap-1">
              <Tag size={10} /> {skill}
            </span>
          ))}
          {service.skills.length > 3 && (
            <span className="text-[10px] text-theme-text">+{service.skills.length - 3} more</span>
          )}
        </div>

        <div className="flex items-center gap-2 pt-4 border-t border-theme-border">
          <Avatar
            src={service.freelancer.avatarUrl}
            alt={service.freelancer.username}
            size={24}
          />
          <span className="text-sm text-theme-text">{service.freelancer.username}</span>
        </div>
      </div>
    </Link>
  );
}
