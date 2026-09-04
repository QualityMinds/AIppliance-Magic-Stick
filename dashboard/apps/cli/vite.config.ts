import {builtinModules} from 'node:module';
import {chmodSync} from 'node:fs';
import {defineConfig} from 'vite';

export default defineConfig({
  plugins: [{
    name: 'magicstick-cli-executable',
    closeBundle() { chmodSync('dist/magicstick.js', 0o755); },
  }],
  build: {
    target: 'node24',
    minify: false,
    sourcemap: true,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'magicstick.js',
    },
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
      output: {banner: '#!/usr/bin/env node'},
    },
  },
});
