// Smoke e2e — parcours critique : boot de l'app, login réel via l'UI,
// gate de consentement RGPD, arrivée sur l'onboarding, navigation.
//
// Le compte est créé via l'API (l'UI ne propose pas d'inscription : les
// comptes sont créés par l'admin en prod). On teste ensuite le VRAI chemin
// navigateur : saisie du formulaire, soumission, transitions de vues.

const { test, expect } = require('@playwright/test');

function uniqueEmail() {
  return `e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}@example.com`;
}
const PASSWORD = 'Correct-horse-9';

test('boot + login + consentement + onboarding + nav', async ({ page, request }) => {
  const email = uniqueEmail();

  // 1) Création du compte via l'API (inscription ouverte en env de test).
  const reg = await request.post('/api/register', { data: { email, password: PASSWORD } });
  expect(reg.ok()).toBeTruthy();

  // 2) Boot de l'app — l'écran de connexion doit apparaître.
  await page.goto('/');
  await expect(page.locator('#viewAuth')).toBeVisible();

  // 3) Login via l'UI (chemin navigateur réel).
  await page.fill('#authEmail', email);
  await page.fill('#authPass', PASSWORD);
  await page.click('#authSubmit');

  // 4) Gate de consentement RGPD (art. 9) — premier login d'un compte neuf.
  const consent = page.locator('#viewConsent');
  await expect(consent).toBeVisible();
  await page.check('#consentHealth');
  await page.click('#consentAcceptBtn');

  // 5) Sans profil, on atterrit sur l'onboarding, et la nav du bas est là.
  await expect(page.locator('#viewOnboarding')).toBeVisible();
  await expect(page.locator('nav.bottom')).toBeVisible();
});

test('healthz profond répond', async ({ request }) => {
  const r = await request.get('/healthz?deep=1');
  expect(r.status()).toBe(200);
  expect(await r.text()).toContain('ok');
});

test('les assets JS découpés se chargent (pas de 404)', async ({ page }) => {
  const failed = [];
  page.on('response', (resp) => {
    if (resp.url().includes('/static/') && resp.status() >= 400) {
      failed.push(`${resp.status()} ${resp.url()}`);
    }
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(failed, 'aucun asset /static/ ne doit 404').toEqual([]);
});
