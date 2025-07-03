// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  build: { outDir: './docs' },   // la build finisce in docs/
});