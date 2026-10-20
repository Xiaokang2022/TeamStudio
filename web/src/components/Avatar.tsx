import { useEffect, useState } from "react";
import { cn, initials } from "../lib/utils";

interface AvatarProps {
  name: string;
  /** Optional uploaded avatar image (e.g. `/uploads/avatars/xxx.png`). */
  src?: string | null;
  color?: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  status?: string;
  className?: string;
}

const STATUS_TONE: Record<string, string> = {
  available: "green",
  busy: "orange",
  remote: "blue",
  offline: "gray",
};

export function Avatar({ name, src, color = "#5865f2", size = "md", status, className }: AvatarProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  const showImage = Boolean(src) && !failed;

  return (
    <span
      className={cn("avatar", `avatar-${size}`, showImage && "avatar-image", className)}
      style={
        showImage
          ? { filter: "none" }
          : { background: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 58%, #0f172a))` }
      }
      title={name}
    >
      {showImage ? (
        <img
          className="avatar-img"
          src={src as string}
          alt={name}
          onError={() => setFailed(true)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            borderRadius: "50%",
            display: "block",
          }}
        />
      ) : (
        <span>{initials(name)}</span>
      )}
      {status ? <i className={cn("avatar-status", `status-${STATUS_TONE[status] ?? "gray"}`)} /> : null}
    </span>
  );
}
