import type { Metadata } from 'next';

import { fontDisplay, fontMono, fontSans } from '@/lib/fonts';

import { Providers } from './providers';

import './globals.css';

export const metadata: Metadata = {
  title: 'Corvid',
  description: 'Autonomous AppSec agent — authorized targets, verified findings only.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fontDisplay.variable} ${fontSans.variable} ${fontMono.variable}`}>
      <body className="bg-signal-field min-h-screen font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
