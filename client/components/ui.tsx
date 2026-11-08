import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./icons";
import { useI18n } from "@/i18n";

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ buttons */

type ButtonVariant = "primary" | "secondary" | "soft" | "ghost" | "danger" | "warn";
type ButtonSize = "sm" | "md" | "lg";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-brand text-brand-ink hover:brightness-110 active:brightness-95 shadow-soft",
  secondary: "border border-line bg-surface text-ink hover:bg-raised active:bg-brand-soft/50",
  soft: "bg-brand-soft text-brand hover:brightness-[0.98]",
  ghost: "text-muted hover:text-ink hover:bg-raised",
  danger: "bg-danger text-white hover:brightness-110",
  warn: "bg-warn-soft text-warn hover:brightness-[0.98]",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-[13px] gap-1.5 rounded-lg",
  md: "h-11 px-4 text-sm gap-2 rounded-xl",
  lg: "h-12 px-5 text-[15px] gap-2 rounded-xl",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
  block?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  loading,
  block,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        block && "w-full",
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner size={size === "sm" ? 14 : 18} /> : icon ? <Icon name={icon} size={size === "sm" ? 15 : 18} /> : null}
      {children}
      {iconRight && !loading ? <Icon name={iconRight} size={size === "sm" ? 15 : 18} /> : null}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  className,
  size = 18,
  variant = "ghost",
  ...rest
}: { icon: IconName; label: string; size?: number; variant?: ButtonVariant } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors disabled:opacity-50",
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

export function Spinner({ size = 18, className, label }: { size?: number; className?: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn("animate-spin", className)}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      role={label ? "status" : undefined}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function LoadingBlock({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted">
      <Spinner size={26} label={label} />
      <span className="text-sm" aria-hidden="true">{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------- inputs */

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-11 w-full rounded-xl border border-line bg-surface px-3 text-[15px] outline-none transition-colors",
        "placeholder:text-muted/50 focus:border-brand focus:ring-2 focus:ring-brand/15 disabled:opacity-60",
        className,
      )}
      {...rest}
    />
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-[15px] leading-relaxed outline-none transition-colors",
        "placeholder:text-muted/50 focus:border-brand focus:ring-2 focus:ring-brand/15",
        className,
      )}
      {...rest}
    />
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        className={cn(
          "h-11 w-full appearance-none rounded-xl border border-line bg-surface pl-3 pr-9 text-[15px] outline-none transition-colors",
          "focus:border-brand focus:ring-2 focus:ring-brand/15",
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      <Icon name="chevronDown" size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  required,
  className,
}: {
  label?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  required?: boolean;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      {label && (
        <span className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
            {label}
            {required && <span className="ml-0.5 text-danger">*</span>}
          </span>
          {hint && <span className="text-[11px] text-muted/80">{hint}</span>}
        </span>
      )}
      {children}
      {error && <span className="mt-1 block text-xs text-danger">{error}</span>}
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-4 py-1 text-left disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-muted">{description}</span>}
      </span>
      <span
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full transition-colors",
          checked ? "bg-brand" : "bg-line",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
            checked ? "left-[22px]" : "left-0.5",
          )}
        />
      </span>
    </button>
  );
}

/* -------------------------------------------------------------------- chrome */

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("rounded-2xl border border-line bg-surface shadow-soft", className)} {...rest}>
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "brand" | "warn" | "danger" | "outline";
  className?: string;
}) {
  const tones = {
    neutral: "bg-raised text-muted",
    brand: "bg-brand-soft text-brand",
    warn: "bg-warn-soft text-warn",
    danger: "bg-danger-soft text-danger",
    outline: "border border-line text-muted",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  back,
  eyebrow,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: () => void;
  eyebrow?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="flex min-w-0 items-start gap-3">
        {back && (
          <button
            onClick={back}
            aria-label={t("Go back")}
            className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-muted transition-colors hover:text-ink"
          >
            <Icon name="arrowLeft" size={17} />
          </button>
        )}
        <div className="min-w-0">
          {eyebrow && <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{eyebrow}</div>}
          <h1 className="break-words font-display text-[26px] leading-tight tracking-tight sm:text-3xl">{title}</h1>
          {subtitle && <p className="mt-1 max-w-2xl text-sm text-muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 sm:pt-1">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon = "box",
  title,
  body,
  action,
}: {
  icon?: IconName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line bg-surface/50 px-6 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-soft text-brand">
        <Icon name={icon} size={22} />
      </div>
      <div>
        <div className="font-display text-lg">{title}</div>
        {body && <div className="mx-auto mt-1 max-w-sm text-sm text-muted">{body}</div>}
      </div>
      {action}
    </div>
  );
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const label = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-brand-soft font-semibold text-brand"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
    >
      {label || "?"}
    </span>
  );
}

export function Tabs({
  items,
  value,
  onChange,
  className,
}: {
  items: { value: string; label: string; count?: number }[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("no-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1 py-1", className)}>
      {items.map((item) => (
        <button
          key={item.value}
          onClick={() => onChange(item.value)}
          className={cn(
            "shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors",
            value === item.value ? "bg-ink text-bg" : "text-muted hover:bg-raised hover:text-ink",
          )}
        >
          {item.label}
          {item.count !== undefined && (
            <span className={cn("ml-1.5 text-[11px]", value === item.value ? "opacity-70" : "opacity-60")}>{item.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------- sheet */

export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const { t } = useI18n();
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px] fade-in" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-line bg-surface sheet-in sm:rounded-3xl",
          wide ? "sm:max-w-2xl" : "sm:max-w-lg",
        )}
      >
        {(title || description) && (
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 pb-3 pt-4">
            <div className="min-w-0">
              {title && <div className="font-display text-xl leading-tight">{title}</div>}
              {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
            </div>
            <IconButton icon="close" label={t("Close")} onClick={onClose} className="-mr-1.5 -mt-0.5" />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="border-t border-line bg-surface px-5 py-3 safe-bottom">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel = "Delete",
  danger = true,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            {t("Cancel")}</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </div>
      }
    >
      {body && <p className="text-sm text-muted">{body}</p>}
    </Sheet>
  );
}

/* -------------------------------------------------------------- misc display */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-xl bg-raised", className)} />;
}

export function Stat({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: IconName;
  tone?: "brand" | "warn" | "danger";
}) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">{label}</span>
        {icon && (
          <span
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-lg",
              tone === "warn" ? "bg-warn-soft text-warn" : tone === "danger" ? "bg-danger-soft text-danger" : "bg-brand-soft text-brand",
            )}
          >
            <Icon name={icon} size={14} />
          </span>
        )}
      </div>
      <div className="mt-1.5 font-display text-2xl leading-none">{value}</div>
      {hint && <div className="mt-1 text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

export function Divider({ className }: { className?: string }) {
  return <div className={cn("h-px w-full bg-line", className)} />;
}

export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
