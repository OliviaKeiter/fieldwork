import type { IconComponent } from './icons';

/** The one empty state in the app.
 *
 * An empty screen is the first thing a new self-hoster sees on almost every
 * page, so it gets a real shape: a muted icon, a short line saying what belongs
 * here, and (where there is one) the action that fills it. */
export default function EmptyState({
  Icon,
  title,
  body,
  action,
}: {
  Icon: IconComponent;
  title: string;
  body: string;
  action?: { label: string; href: string };
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface px-6 py-16 text-center">
      <span
        aria-hidden="true"
        className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-text-dim"
      >
        <Icon className="h-5 w-5" />
      </span>
      <p className="mt-4 text-sm font-medium text-text">{title}</p>
      <p className="mt-1.5 max-w-sm text-sm text-text-dim">{body}</p>
      {action && (
        <a
          href={action.href}
          className="mt-5 rounded-lg bg-accent px-3.5 py-2 text-xs font-medium text-bg transition-opacity hover:opacity-90"
        >
          {action.label}
        </a>
      )}
    </div>
  );
}
