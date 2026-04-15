// astro.config.mjs
import { defineConfig } from 'astro/config';
import netlify   from '@astrojs/netlify';   // 👈 nuovo adapter
import react     from '@astrojs/react';
import tailwind  from '@astrojs/tailwind';
import Icons     from 'astro-icon';

import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

export default defineConfig({
  // ――― Adapter ―――
  adapter: netlify({
    dist: { outDir: './docs' },   // cartella di output (Netlify la serve in automatico)
    edge: false     // true se vuoi Edge Functions
  }),

  // ――― Integrazioni ―――
  integrations: [
    tailwind(),
    react(),
    Icons({
      collections: { local: './src/icons' }
    })
  ],

  vite: {
    envPrefix: ['PUBLIC_', 'VITE_']
  },

  // ――― Sito pubblico (opzionale ma consigliato) ―――
  site: 'https://normaxlabs.github.io',

  // ――― Markdown & KaTeX ―――
  markdown: {
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex]
  }
});
