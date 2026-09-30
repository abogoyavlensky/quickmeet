// Browser tests against the built binary. `lgx e2e` builds ../bin/quickmeet
// and runs `npx playwright test` here; Playwright starts the binary itself
// (webServer) on test ports with a throwaway database, waits for the landing
// page, runs the specs, and on teardown SIGKILLs the whole process group
// (processLauncher.js, `process.kill(-pid, 'SIGKILL')`). That is why the app
// needs no shutdown handling for the tests to leave no process behind.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8099',
    trace: 'retain-on-failure',
    permissions: ['camera', 'microphone'],
    launchOptions: {
      // A synthetic camera and microphone through the normal getUserMedia
      // path, with no permission prompt, and autoplay for the remote <video>.
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'rm -f .tmp/quickmeet.db .tmp/quickmeet.db-wal .tmp/quickmeet.db-shm && mkdir -p .tmp && ../bin/quickmeet',
    url: 'http://127.0.0.1:8099/',
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    // Dedicated ports so a developer's `lgx run` on the defaults can coexist.
    env: {
      PORT: '8099',
      LIVEKIT_PORT: '7899',
      LIVEKIT_RTC_TCP_PORT: '7898',
      LIVEKIT_UDP_START: '50200',
      LIVEKIT_UDP_END: '50300',
      DB_PATH: '.tmp/quickmeet.db',
      LIVEKIT_LOG_LEVEL: 'warn',
      // Every test signs up its own account from 127.0.0.1, far past the
      // sign-up limit of 10 an hour per address.
      RATE_LIMIT: 'false',
    },
  },
});
