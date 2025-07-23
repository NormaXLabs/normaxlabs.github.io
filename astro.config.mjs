// astro.config.mjs
import { defineConfig } from 'astro/config';
import netlify   from '@astrojs/netlify';   // 👈 nuovo adapter
import tailwind  from '@astrojs/tailwind';
import Icons     from 'astro-icon';

import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

export default defineConfig({
  // ――― Adapter ―――
  adapter: netlify({
    dist: 'dist',   // cartella di output (Netlify la serve in automatico)
    edge: false     // true se vuoi Edge Functions
  }),

  // ――― Integrazioni ―――
  integrations: [
    tailwind(),
    Icons({
      collections: { local: './src/icons' }
    })
  ],

  // ――― Sito pubblico (opzionale ma consigliato) ―――
  site: 'https://normaxlabs.netlify.app',

  // ――― Markdown & KaTeX ―――
  markdown: {
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex]
  }
});
