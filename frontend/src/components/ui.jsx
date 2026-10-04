import { AlertCircle, CheckCircle2, Info, Loader2 } from 'lucide-react';

const VARIANTS = {
  info: { wrap: 'bg-blue-50 text-blue-800 border-blue-200', Icon: Info },
  success: { wrap: 'bg-emerald-50 text-emerald-800 border-emerald-200', Icon: CheckCircle2 },
  error: { wrap: 'bg-red-50 text-red-800 border-red-200', Icon: AlertCircle },
  warning: { wrap: 'bg-amber-50 text-amber-800 border-amber-200', Icon: AlertCircle },
};

/** Inline status banner used across forms and detail pages. */
export function Alert({ variant = 'info', children, onDismiss }) {
  if (!children) return null;
  const { wrap, Icon } = VARIANTS[variant] || VARIANTS.info;
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${wrap}`} role="status">
      <Icon size={16} className="mt-0.5 shrink-0" />
      <span className="flex-1">{children}</span>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100">
          ×
        </button>
      ) : null}
    </div>
  );
}

/** Full-width spinner with an accessible label. */
export function Spinner({ label = 'Loading…', className = '' }) {
  return (
    <div className={`flex items-center justify-center gap-2 py-10 text-sm text-slate-500 ${className}`}>
      <Loader2 size={18} className="animate-spin" />
      <span>{label}</span>
    </div>
  );
}

/** Empty-state block with an optional call to action. */
export function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {Icon ? (
        <div className="mb-4 rounded-full bg-slate-100 p-4">
          <Icon size={24} className="text-slate-400" />
        </div>
      ) : null}
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      {description ? <p className="mt-1 max-w-md text-sm text-slate-500">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/** Pill used for statuses and tags. */
export function Badge({ children, className = 'bg-slate-100 text-slate-700' }) {
  return <span className={`badge ${className}`}>{children}</span>;
}

/** Labelled form field with inline validation message. */
export function Field({ label, error, hint, children, required }) {
  return (
    <div>
      <label className="label">
        {label}
        {required ? <span className="ml-0.5 text-red-500">*</span> : null}
      </label>
      {children}
      {hint && !error ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}

/** Toggle switch used for enrichment / AI options. */
export function Toggle({ checked, onChange, label, description, disabled }) {
  return (
    <label
      className={`flex items-start gap-3 rounded-lg border border-slate-200 p-3 ${
        disabled ? 'opacity-60' : 'cursor-pointer hover:bg-slate-50'
      }`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-brand-600' : 'bg-slate-300'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        {description ? <span className="block text-xs text-slate-500">{description}</span> : null}
      </span>
    </label>
  );
}

/** Page header with an optional action slot. */
export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}