import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    clean: true,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entry: { 'session-start': 'src/hook/session-start.ts' },
    outDir: 'plugin/hooks',
    format: ['esm'],
    target: 'node20',
    outExtension: () => ({ js: '.mjs' }),
    noExternal: [/.*/],
    clean: false,
  },
]);
