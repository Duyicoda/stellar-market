import Image from "next/image";

interface AvatarProps {
  /** URL of the avatar image */
  src?: string | null;
  /** Alt text for the image (also used for fallback initial) */
  alt?: string;
  /** Size in pixels (width and height will be equal) */
  size?: number;
  /** Whether to load the image with priority (for above-the-fold images) */
  priority?: boolean;
  /** Additional CSS classes to apply */
  className?: string;
  /** Whether to use unoptimized mode for next/image (useful for external URLs) */
  unoptimized?: boolean;
}

export default function Avatar({
  src,
  alt = "User",
  size = 32,
  priority = false,
  className = "",
  unoptimized = false,
}: AvatarProps) {
  const initial = alt?.charAt(0)?.toUpperCase() || "U";

  return (
    <div
      className={`rounded-full bg-gradient-to-br from-stellar-blue to-stellar-purple flex items-center justify-center overflow-hidden ${className}`}
      style={{ width: size, height: size }}
    >
      {src ? (
        <Image
          src={src}
          alt={alt}
          width={size}
          height={size}
          className="w-full h-full object-cover"
          priority={priority}
          unoptimized={unoptimized}
        />
      ) : (
        <span className="text-white font-bold" style={{ fontSize: size * 0.5 }}>
          {initial}
        </span>
      )}
    </div>
  );
}
