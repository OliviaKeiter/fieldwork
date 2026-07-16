// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';

import tailwindcss from '@tailwindcss/vite';

import netlify from '@astrojs/netlify';

// https://astro.build/config
export default defineConfig({
  integrations: [react()],

  // Honor an externally assigned port (e.g. a second dev server next to the default one).
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 4321,
  },

  vite: {
    plugins: [tailwindcss()]
  },

  adapter: netlify()
});