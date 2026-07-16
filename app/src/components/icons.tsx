/* Fieldwork icon set.
 *
 * One house style, no exceptions: 24x24 viewBox, stroke-only, `currentColor`,
 * 1.75 stroke width, round caps and joins. Size comes from the caller via
 * className (h-5 w-5 in nav, h-4 w-4 inline, h-6 w-6 for empty states) so an
 * icon always inherits the text color and optical weight of what it sits next to.
 *
 * Deliberately no emoji anywhere in the app: emoji render differently per OS and
 * per font, they carry a color we do not control, and they cannot inherit the
 * theme. These do.
 */

import type { ComponentType } from 'react';

export interface IconProps {
  className?: string;
  /* Icons are decorative by default; the adjacent label carries the meaning.
     Pass a title only when an icon is the sole content of a control. */
  title?: string;
}

/** What to type a prop as when a component takes "an icon" and renders it.
 *  (Not `(p: IconProps) => JSX.Element` — React 19 dropped the global JSX
 *  namespace, so that no longer typechecks.) */
export type IconComponent = ComponentType<IconProps>;

function svgProps(className = 'h-5 w-5', title?: string) {
  return {
    className,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    role: title ? ('img' as const) : undefined,
    'aria-hidden': title ? undefined : (true as const),
  };
}

/* --- Navigation ------------------------------------------------------- */

/** Today: a sun. The day's work, the thing that is happening now. */
export function IconToday({ className, title }: IconProps) {
  return (
    <svg {...svgProps(className, title)}>
      {title && <title>{title}</title>}
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

/** Pipeline: kanban columns. */
export function IconPipeline({ className, title }: IconProps) {
  return (
    <svg {...svgProps(className, title)}>
      {title && <title>{title}</title>}
      <rect x="3" y="4" width="5" height="16" rx="1.5" />
      <rect x="9.5" y="4" width="5" height="11" rx="1.5" />
      <rect x="16" y="4" width="5" height="7" rx="1.5" />
    </svg>
  );
}

/** Intake: a tray with something arriving in it. */
export function IconIntake({ className, title }: IconProps) {
  return (
    <svg {...svgProps(className, title)}>
      {title && <title>{title}</title>}
      <path d="M3 14h4l1.5 2.5h7L17 14h4" />
      <path d="M5.5 5.5A1.5 1.5 0 017 4.5h10a1.5 1.5 0 011.5 1l2.5 8v3.5a1.5 1.5 0 01-1.5 1.5H4.5A1.5 1.5 0 013 17V14z" />
    </svg>
  );
}

/** Contacts: people. */
export function IconContacts({ className, title }: IconProps) {
  return (
    <svg {...svgProps(className, title)}>
      {title && <title>{title}</title>}
      <circle cx="9" cy="8" r="3.25" />
      <path d="M2.5 19.5a6.5 6.5 0 0113 0" />
      <path d="M16 5.5a3.25 3.25 0 010 5.9" />
      <path d="M18 14.2a6.5 6.5 0 013.5 5.3" />
    </svg>
  );
}

/** Insights: bars. */
export function IconInsights({ className, title }: IconProps) {
  return (
    <svg {...svgProps(className, title)}>
      {title && <title>{title}</title>}
      <path d="M3 21h18" />
      <rect x="4.5" y="12" width="4" height="6" rx="1" />
      <rect x="10" y="7" width="4" height="11" rx="1" />
      <rect x="15.5" y="3.5" width="4" height="14.5" rx="1" />
    </svg>
  );
}

/** Settings: sliders. Reads as "tune the rules" better than a gear. */
export function IconSettings({ className, title }: IconProps) {
  return (
    <svg {...svgProps(className, title)}>
      {title && <title>{title}</title>}
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2.25" />
      <circle cx="8" cy="17" r="2.25" />
    </svg>
  );
}

/** Dossier: a building. The company view. */
export function IconDossier({ className, title }: IconProps) {
  return (
    <svg {...svgProps(className, title)}>
      {title && <title>{title}</title>}
      <path d="M3 21h18" />
      <path d="M5 21V5a1.5 1.5 0 011.5-1.5h7A1.5 1.5 0 0115 5v16" />
      <path d="M15 21V10h3.5A1.5 1.5 0 0120 11.5V21" />
      <path d="M8 7.5h1.5M8 11h1.5M8 14.5h1.5M11.5 7.5H13M11.5 11H13M11.5 14.5H13" />
    </svg>
  );
}

/* --- Queue item kinds -------------------------------------------------- */

/** Thank-you: an envelope. */
export function IconMail({ className, title }: IconProps) {
  return (
    <svg {...svgProps(className, title)}>
      {title && <title>{title}</title>}
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3.5 6.5l7.6 5.2a1.6 1.6 0 001.8 0l7.6-5.2" />
    </svg>
  );
}

/** Nudge: a bell. */
export function IconBell({ className, title }: IconProps) {
  return (
    <svg {...svgProps(className, title)}>
      {title && <title>{title}</title>}
      <path d="M18 9a6 6 0 10-12 0c0 4.5-1.5 5.5-2 6.5h16c-.5-1-2-2-2-6.5z" />
      <path d="M10 19a2.2 2.2 0 004 0" />
    </svg>
  );
}

/** Still queued: a clock. Time passing on something you have not sent. */
export function IconClock({ className, title }: IconProps) {
  return (
    <svg {...svgProps(className, title)}>
      {title && <title>{title}</title>}
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.2l3.2 2" />
    </svg>
  );
}

/** Upcoming interview: a calendar. */
export function IconCalendar({ className, title }: IconProps) {
  return (
    <svg {...svgProps(className, title)}>
      {title && <title>{title}</title>}
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

/* --- Controls ---------------------------------------------------------- */

export function IconMoon({ className, title }: IconProps) {
  return (
    <svg {...svgProps(className, title)}>
      {title && <title>{title}</title>}
      <path d="M20 13.5A8.5 8.5 0 1110.5 4a6.9 6.9 0 009.5 9.5z" />
    </svg>
  );
}

/** Collapse/expand the sidebar: a panel with its rail called out. */
export function IconPanel({ className, title }: IconProps) {
  return (
    <svg {...svgProps(className, title)}>
      {title && <title>{title}</title>}
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9.5 4v16" />
    </svg>
  );
}

/** Paired with IconChevronDown for reorder controls (move up / move down).
 *  A rotated Down would do, but a real Up keeps the two call sites symmetrical. */
export function IconChevronUp({ className, title }: IconProps) {
  return (
    <svg {...svgProps(className, title)}>
      {title && <title>{title}</title>}
      <path d="M5.5 15L12 8.5 18.5 15" />
    </svg>
  );
}

/** Disclosure caret. Points down when open; callers rotate it with a class
 *  (`-rotate-90`) when closed, so one icon covers both states. */
export function IconChevronDown({ className, title }: IconProps) {
  return (
    <svg {...svgProps(className, title)}>
      {title && <title>{title}</title>}
      <path d="M5.5 9L12 15.5 18.5 9" />
    </svg>
  );
}

export function IconChevronLeft({ className, title }: IconProps) {
  return (
    <svg {...svgProps(className, title)}>
      {title && <title>{title}</title>}
      <path d="M14.5 5.5L8 12l6.5 6.5" />
    </svg>
  );
}

export function IconArrowRight({ className, title }: IconProps) {
  return (
    <svg {...svgProps(className, title)}>
      {title && <title>{title}</title>}
      <path d="M4 12h15M13 6l6 6-6 6" />
    </svg>
  );
}

export function IconClose({ className, title }: IconProps) {
  return (
    <svg {...svgProps(className, title)}>
      {title && <title>{title}</title>}
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function IconCheck({ className, title }: IconProps) {
  return (
    <svg {...svgProps(className, title)}>
      {title && <title>{title}</title>}
      <path d="M4.5 12.5l5 5 10-11" />
    </svg>
  );
}
