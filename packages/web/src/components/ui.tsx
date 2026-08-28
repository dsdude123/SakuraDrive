import type { ReactNode } from 'react';
import type { Severity } from '@sakuradrive/shared';

/* --------------------------------------------------------------------- card */

export function Card({
  title,
  description,
  actions,
  children,
  flush,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}): JSX.Element {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-header">
          <div className="card-title">
            {typeof title === 'string' ? <h2>{title}</h2> : title}
            {description && <span className="card-desc">{description}</span>}
          </div>
          {actions && <div className="button-row">{actions}</div>}
        </header>
      )}
      <div className={flush ? 'card-body flush' : 'card-body'}>{children}</div>
    </section>
  );
}

/* --------------------------------------------------------------------- stat */

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'ok' | 'warning' | 'critical' | 'accent';
}): JSX.Element {
  return (
    <div className={tone ? `stat ${tone}` : 'stat'}>
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {hint !== undefined && <span className="hint">{hint}</span>}
    </div>
  );
}

/* -------------------------------------------------------------------- badge */

export type BadgeTone = 'ok' | 'info' | 'warning' | 'critical' | 'neutral' | 'accent';

export function Badge({
  tone = 'neutral',
  children,
  dot,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  dot?: boolean;
}): JSX.Element {
  return (
    <span className={`badge ${tone}`}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

export function severityTone(severity: Severity | null | undefined): BadgeTone {
  if (severity === 'critical') return 'critical';
  if (severity === 'warning') return 'warning';
  if (severity === 'info') return 'info';
  return 'ok';
}

export function SeverityBadge({
  severity,
  okLabel = 'Healthy',
}: {
  severity: Severity | null | undefined;
  okLabel?: string;
}): JSX.Element {
  const label = severity ? severity[0]!.toUpperCase() + severity.slice(1) : okLabel;
  return (
    <Badge tone={severityTone(severity)} dot>
      {label}
    </Badge>
  );
}

/* ----------------------------------------------------------------- messages */

export function Banner({
  tone = 'info',
  title,
  children,
  actions,
}: {
  tone?: 'info' | 'ok' | 'warning' | 'critical';
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <div className={`banner ${tone}`} role={tone === 'critical' ? 'alert' : undefined}>
      <div style={{ flex: 1 }}>
        {title && <strong>{title}</strong>}
        {children}
      </div>
      {actions}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div>{children}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }): JSX.Element {
  return (
    <div className="empty">
      <span className="spinner" /> <span style={{ marginLeft: 8 }}>{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------- modal */

export function Modal({
  title,
  onClose,
  children,
  actions,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="card modal">
        <header className="card-header">
          <h2>{title}</h2>
          <button className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="card-body">{children}</div>
        {actions && (
          <div className="card-header" style={{ borderTop: '1px solid var(--border)', borderBottom: 'none' }}>
            <span className="spacer" />
            <div className="button-row">{actions}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ fields */

export function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {help && <span className="help">{help}</span>}
    </label>
  );
}

export function Checkbox({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        {label}
        {help && <span className="help">{help}</span>}
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------- table */

export function Table({
  headers,
  children,
}: {
  headers: ReactNode[];
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((header, index) => (
              <th key={index} className={typeof header === 'string' && header.startsWith('#') ? 'num' : undefined}>
                {typeof header === 'string' && header.startsWith('#') ? header.slice(1) : header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
