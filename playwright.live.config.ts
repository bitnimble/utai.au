import { defineConfig, devices } from '@playwright/test';

// Happy-path e2e for the music-source flow, run against an ALREADY-RUNNING full
// stack (app + backend behind one origin), not a Vite server this config spawns:
// the flow fetches a real track through OnTheSpot, which the stub-based
// `bun run e2e` suite (frontend/src/**/*.e2e.ts, backend-less Vite) can't do.
//
//   bun run e2e:live
//
// Defaults to the local Caddy edge from docker-compose.dev.yml. Override
// E2E_BASE_URL (e.g. in .env, which the script loads) to reach the stack from a
// sandboxed host that can't see published ports on localhost -- there it's
// http://host.docker.internal:8080.
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8080';

export default defineConfig({
  testDir: './e2e-live',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 200_000, // a real track download is slow
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 30_000,
  },
  projects: [
    {
      name: 'live',
      use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--no-sandbox'] } },
    },
  ],
});
