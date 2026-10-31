import { defineConfig } from '@playwright/test';

const port = Number(process.env.PORT ?? 4173); // override when another checkout is testing at the same time

// Tests run against the production build (what gets deployed).
// Locally use the installed Chrome; CI installs Playwright's Chromium
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${port}/`,
    channel: process.env.CI ? undefined : 'chrome',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  webServer: {
    command: `npm run build && npx vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}/`,
    reuseExistingServer: !process.env.CI,
  },
});
