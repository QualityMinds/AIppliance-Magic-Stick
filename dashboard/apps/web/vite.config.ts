import react from '@vitejs/plugin-react';
import {defineConfig} from 'vitest/config';
import {searchForWorkspaceRoot} from 'vite';
import {fileURLToPath} from 'node:url';

const licenseSources = ['LICENSE', 'LICENSING.md', 'licenses/MIT-CHANGE.txt', 'THIRD_PARTY_NOTICES.md', 'licenses/third-party/npm.txt', 'licenses/third-party/python.txt'].flatMap((path) => {
  const file = fileURLToPath(new URL('../../../' + path, import.meta.url));
  // Vite checks both the physical path and the literal raw-import ID.
  return [file, `${file}?raw`];
});

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    // Only source-of-truth legal documents sit outside the pnpm root.
    fs: {allow: [searchForWorkspaceRoot(process.cwd()), ...licenseSources]},
    proxy: {
      '/api': {
        target: process.env.MAGICSTICK_API_PROXY ?? 'https://magicstick.local',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
  },
});
