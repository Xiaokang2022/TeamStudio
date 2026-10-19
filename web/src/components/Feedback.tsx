import type { ReactNode } from "react";
import { Inbox, Loader2 } from "lucide-react";

export function EmptyState({
  title,
  description,
  action,
  icon,
  compact = false,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "empty-state empty-compact" : "empty-state"}>
      <div className="empty-icon">{icon ?? <Inbox size={24} />}</div>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function LoadingBlock({ label = "加载中…", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="loading-block" aria-label={label}>
      <div className="loading-label">
        <Loader2 size={16} className="spin" />
        <span>{label}</span>
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton skeleton-row" style={{ width: `${92 - index * 9}%` }} />
      ))}
    </div>
  );
}

export function PageLoading() {
  return (
    <div className="page-loading">
      <span className="page-loading-mark">TS</span>
      <div className="page-loading-bar">
        <i />
      </div>
      <p>正在打开团队工作室…</p>
    </div>
  );
}
