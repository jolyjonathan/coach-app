// Playwright — config e2e pour Coach Adaptatif.
//
// Le webServer build le binaire Go et le lance avec un env de TEST :
//   - 2FA désactivée (sinon le smoke test devrait scanner un QR TOTP),
//   - inscription ouverte (le test crée son propre compte),
//   - clé de chiffrement éphémère, data dir jetable.
//
// Lancer en local :  npx playwright test --config e2e/playwright.config.js
// CI : voir .github/workflows/ci.yml (job e2e).

const { defineConfig, devices } = require('@playwright/test');

const PORT = 8099;

module.exports = defineConfig({
  testDir: '.',
  timeout: 30000,
  expect: { timeout: 7000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'mobile-chrome', use: { ...devices['Pixel 5'] } },
  ],
  webServer: {
    // Build puis run. Le data dir est un tmp jetable propre à chaque run.
    command: [
      'cd "$(git rev-parse --show-toplevel)"',
      'go build -o /tmp/coach-e2e .',
      'rm -rf /tmp/coach-e2e-data && mkdir -p /tmp/coach-e2e-data',
      [
        'COACH_TOKEN_KEY=' + '0'.repeat(64),
        'COACH_2FA_REQUIRED=0',
        'COACH_ALLOW_REGISTRATION=1',
        'COACH_DATA=/tmp/coach-e2e-data',
        // Backend MariaDB obligatoire. La CI fournit un service MariaDB et
        // exporte COACH_DB ; en local, défaut sur une base coach_e2e locale.
        'COACH_DB="' + (process.env.COACH_DB ||
          'root:root@tcp(127.0.0.1:3306)/coach_e2e?parseTime=true&loc=UTC&charset=utf8mb4') + '"',
        'COACH_PUBLIC="$(git rev-parse --show-toplevel)/public"',
        'COACH_LISTEN=127.0.0.1:' + PORT,
        '/tmp/coach-e2e',
      ].join(' '),
    ].join(' && '),
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
