import { defineConfig } from 'vitest/config';
import { execSync } from 'node:child_process';

// Version for the footer (index.html %VITE_VERSION%): the tag on this commit, else tag-commits-hash
try { process.env.VITE_VERSION ??= execSync('git describe --tags --always', { encoding: 'utf8' }).trim(); } catch { process.env.VITE_VERSION ??= 'dev'; }

export default defineConfig({
  base: './', // relative, so the build works at the GitHub Pages subpath and at the root
  test: { include: ['src/**/*.test.ts'] },
});
