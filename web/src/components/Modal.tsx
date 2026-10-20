import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X } from "lucide-react";
import { cn } from "../lib/utils";

interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}

/**
 * Nested modals (e.g. a delete confirmation on top of the workspace manager)
 * must only let the topmost dialog react to Escape, otherwise one key press
 * would close both layers.
 */
const modalEscapeStack: Array<() => void> = [];

export function Modal({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  size = "md",
  className,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handleEscape = () => onClose();
    modalEscapeStack.push(handleEscape);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (modalEscapeStack[modalEscapeStack.length - 1] !== handleEscape) return;
      handleEscape();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      const index = modalEscapeStack.lastIndexOf(handleEscape);
      if (index >= 0) modalEscapeStack.splice(index, 1);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose} role="presentation">
      <div
        className={cn("modal-panel", `modal-${size}`, className)}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button className="icon-button modal-close" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onClose: () => void;
  onConfirm: () => void;
  loading?: boolean;
  tone?: "danger" | "primary";
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "确认删除",
  onClose,
  onConfirm,
  loading,
  tone = "danger",
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={loading}>
            取消
          </button>
          <button className={cn("btn", tone === "danger" ? "btn-danger" : "btn-primary")} onClick={onConfirm} disabled={loading}>
            {loading ? "处理中…" : confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-content">
        <span className="confirm-icon">
          <AlertTriangle size={20} />
        </span>
        <p>{message}</p>
      </div>
    </Modal>
  );
}

interface ConfirmInputDialogProps {
  open: boolean;
  title: string;
  description?: string;
  /** Warning copy, usually describing what will be destroyed and that it is irreversible. */
  message: ReactNode;
  /** Exact name the administrator has to type before the destructive action unlocks. */
  expected: string;
  inputLabel?: string;
  confirmLabel?: string;
  onClose: () => void;
  onConfirm: () => void;
  loading?: boolean;
}

/**
 * Destructive confirmation that requires typing an exact name.
 *
 * Keyboard behaviour: the input receives focus when the dialog opens, Enter submits
 * only once the typed name matches, and Escape / backdrop closes the dialog unless
 * a request is in flight. Styling for `.confirm-input*` lives in WorkspaceManager.css.
 */
export function ConfirmInputDialog({
  open,
  title,
  description,
  message,
  expected,
  inputLabel = "输入名称以确认",
  confirmLabel = "永久删除",
  onClose,
  onConfirm,
  loading = false,
}: ConfirmInputDialogProps) {
  const inputId = useId();
  const hintId = useId();
  const formId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    if (!open) return;
    setValue("");
  }, [open, expected]);

  useEffect(() => {
    if (!open) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Focus after the portal has painted, so the caret lands in the input reliably.
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => {
      window.clearTimeout(timer);
      previousFocus?.focus();
    };
  }, [open]);

  const target = expected.trim();
  const trimmed = value.trim();
  const matches = target.length > 0 && trimmed === target;
  const mismatch = trimmed.length > 0 && !matches;

  const close = () => {
    if (loading) return;
    onClose();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!matches || loading) return;
    onConfirm();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={close} disabled={loading}>
            取消
          </button>
          <button className="btn btn-danger" type="submit" form={formId} disabled={!matches || loading}>
            {loading ? "处理中…" : confirmLabel}
          </button>
        </>
      }
    >
      <form id={formId} className="confirm-input" onSubmit={submit}>
        <div className="confirm-content">
          <span className="confirm-icon">
            <AlertTriangle size={20} />
          </span>
          <div className="confirm-input-message">{message}</div>
        </div>
        <div className="field">
          <label htmlFor={inputId}>{inputLabel}</label>
          <input
            id={inputId}
            ref={inputRef}
            className={cn("input", mismatch && "is-invalid")}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={expected}
            autoComplete="off"
            spellCheck={false}
            disabled={loading}
            aria-invalid={mismatch || undefined}
            aria-describedby={hintId}
          />
          <span
            id={hintId}
            className={cn("field-hint", mismatch && "confirm-input-hint-error")}
            aria-live="polite"
          >
            {matches ? (
              "名称已匹配，可以确认删除。"
            ) : mismatch ? (
              <>
                名称不匹配，请完整输入 <code className="confirm-input-target">{expected}</code>。
              </>
            ) : (
              <>
                请输入完整名称 <code className="confirm-input-target">{expected}</code> 以启用删除按钮。
              </>
            )}
          </span>
        </div>
      </form>
    </Modal>
  );
}
