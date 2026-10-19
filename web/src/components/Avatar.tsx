import { cn, initials } from "../lib/utils";

interface AvatarProps {
  name: string;
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

export function Avatar({ name, color = "#5865f2", size = "md", status, className }: AvatarProps) {
  return (
    <span
      className={cn("avatar", `avatar-${size}`, className)}
      style={{ background: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 58%, #0f172a))` }}
      title={name}
    >
      <span>{initials(name)}</span>
      {status ? <i className={cn("avatar-status", `status-${STATUS_TONE[status] ?? "gray"}`)} /> : null}
    </span>
  );
}
