import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  output: 'static',
  build: { outDir: './docs' },
  integrations: [tailwind()],
  site: 'https://<org>.github.io',   // URL pubblico (importante per i link absolute)
});