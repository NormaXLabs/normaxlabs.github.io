import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import icon     from 'astro-icon';

export default defineConfig({
  output: 'static',
  build: { outDir: './docs' },
  integrations: [tailwind(), icon()],
  site: 'https://normaxlabs.github.io',   // URL pubblico (importante per i link absolute)
});