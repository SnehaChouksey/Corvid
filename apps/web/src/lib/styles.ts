// Shared class strings for interactive controls so every button on the page
// shares one motion/spacing/color contract (skill B7/B9). Kept as plain
// exported strings (no component wrapper) since both <a> and <button> need
// the same visual treatment across the page.

const TRANSITION = 'transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)]';

// Primary CTA: squared-off instrument-switch shape (not a pill) — deliberately
// distinct from the pill-shaped nav so the "commit" action reads as a
// physical toggle, not another rounded SaaS button. Signal is never used as
// a background fill (skill B4) — only border/ring/text.
export const BUTTON_PRIMARY = `inline-flex items-center justify-center gap-2 rounded-lg border border-signal/40 bg-steel px-6 py-3 text-base font-semibold text-chalk ${TRANSITION} hover:-translate-y-0.5 hover:border-signal hover:bg-slate hover:ring-2 hover:ring-signal/20 active:translate-y-0 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-ink disabled:pointer-events-none disabled:opacity-50`;

// Same button, kept as a pill for the nested contexts it appears in (the
// floating island nav pill and its mobile overlay) — skill B3 nested-radius:
// a squared button inside a rounded-full pill would fight its container.
export const BUTTON_PRIMARY_SM = `inline-flex items-center justify-center gap-2 rounded-full border border-signal/40 bg-steel px-4 py-2 text-sm font-semibold text-chalk ${TRANSITION} hover:-translate-y-0.5 hover:border-signal hover:ring-2 hover:ring-signal/20 active:translate-y-0 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-ink disabled:pointer-events-none disabled:opacity-50`;

// Quiet text link used for nav items and footer links.
export const LINK_QUIET = `text-sm font-semibold text-fog ${TRANSITION} hover:text-chalk focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-ink rounded-md`;

// Mono "channel" index label reused wherever content is presented as a
// numbered instrument reading (how-it-works, coverage, FAQ, the sealed
// finding) — CH.01 style, never decorative, always paired with real content.
export const CHANNEL_LABEL = 'font-mono text-xs tracking-wider text-signal';
