import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import icon from 'astro-icon';

// Marketing landing site. Static output; Tailwind v4 via the official Vite plugin
// (repo standardises on Tailwind v4, matching apps/dashboard). `site` powers
// canonical URLs, sitemap, and og tags — update to the real domain before launch.
// astro-icon + @iconify-json/ph gives us Phosphor icons via <Icon name="ph:..." />.
export default defineConfig({
  site: 'https://corvid.security',
  integrations: [icon()],
  vite: {
    plugins: [tailwindcss()],
  },
});
