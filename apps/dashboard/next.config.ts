import type { NextConfig } from 'next';

// Composition root for the Next.js build (`02` §6 dashboard). No server-side rendering of
// API data here by design: every screen fetches via TanStack Query against the gateway with
// browser-managed session cookies (`credentials: 'include'`), so this app owns no server secrets.
const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
