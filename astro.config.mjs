import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import Icons     from 'astro-icon';

import { defineConfig } from 'astro/config';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

export default defineConfig({
  output: 'static',
  build: { outDir: './docs' },
  integrations: [tailwind(), Icons({
      collections: {
        //   nome set : percorso cartella
        local: './src/icons',
      },
    })],
  site: 'https://normaxlabs.github.io',   // URL pubblico (importante per i link absolute),
  markdown: {
    // abilita parsing TeX
    remarkPlugins: [remarkMath],
    // trasforma AST in rendering KaTeX
    rehypePlugins: [rehypeKatex],
  },
});

