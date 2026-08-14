import { IBM_Plex_Mono, IBM_Plex_Sans, Instrument_Serif } from 'next/font/google';

// Type pairing (frontend-design skill): an editorial display serif for authority/weight on the
// two safety-critical screens and report headings, a technical grotesque for UI chrome, and a
// monospace for every value that is literally attacker/analyst-facing data — endpoints, tokens,
// payloads, proofs, hashes, timestamps — so the analyst can visually distinguish "data" from "UI".
export const fontDisplay = Instrument_Serif({
  subsets: ['latin'],
  weight: ['400'],
  style: ['normal', 'italic'],
  variable: '--font-display',
  display: 'swap',
});

export const fontSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

export const fontMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});
