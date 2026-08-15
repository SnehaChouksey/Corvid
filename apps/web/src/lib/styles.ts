// Shared class strings for interactive controls so every button on the page
// shares one motion/spacing/color contract (skill B7/B9). Kept as plain
// exported strings (no component wrapper) since both <a> and <button> need
// the same visual treatment across the page.

const TRANSITION = 'transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)]';

// Primary CTA: lightest approved background (steel) + signal border/ring accent.
// Signal is never used as a background fill (skill B4) — only border/ring/text.
export const BUTTON_PRIMARY = `inline-flex items-center justify-center gap-2 rounded-full border border-signal/30 bg-steel px-6 py-3 text-base font-semibold text-chalk ${TRANSITION} hover:-translate-y-0.5 hover:border-signal hover:ring-2 hover:ring-signal/20 active:translate-y-0 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-ink disabled:pointer-events-none disabled:opacity-50`;

// Same button, sized for the nav (text-sm semibold per skill spacing rules).
export const BUTTON_PRIMARY_SM = `inline-flex items-center justify-center gap-2 rounded-full border border-signal/30 bg-steel px-4 py-2 text-sm font-semibold text-chalk ${TRANSITION} hover:-translate-y-0.5 hover:border-signal hover:ring-2 hover:ring-signal/20 active:translate-y-0 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-ink disabled:pointer-events-none disabled:opacity-50`;

// Quiet text link used for nav items and footer links.
export const LINK_QUIET = `text-sm font-semibold text-fog ${TRANSITION} hover:text-chalk focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-ink rounded-md`;
