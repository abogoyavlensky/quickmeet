// The app as installed to a home screen, where there is no address bar and
// no browser Back button: the manifest and its icons, a way back to the
// room list from every page that leads off it, and what stays in view.
import { test, expect } from '@playwright/test';
import { newRoom } from './helpers.js';

test('Back leads to the room list from the lobby, history and settings', async ({ page }) => {
  await newRoom(page);
  for (const from of [null, '/history', '/settings']) {
    if (from) await page.goto(from);
    await page.getByRole('link', { name: 'Back' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('#new')).toBeVisible();
  }
});

test('Back is hidden in a call', async ({ page }) => {
  await newRoom(page);
  await expect(page.getByRole('link', { name: 'Back' })).toBeVisible();
  await page.click('#join');
  await page.waitForFunction(() => window.call.joined === true, null, { timeout: 15_000 });
  await expect(page.getByRole('link', { name: 'Back' })).toBeHidden();
});

test('the manifest and its icons load', async ({ page }) => {
  await page.goto('/');
  const href = await page.locator('link[rel=manifest]').getAttribute('href');
  const res = await page.request.get(href);
  expect(res.status()).toBe(200);
  const manifest = await res.json();
  expect(manifest.display).toBe('standalone');
  for (const { src } of manifest.icons) {
    const icon = await page.request.get(src);
    expect(icon.status(), src).toBe(200);
    expect(icon.headers()['content-type'], src).toBe('image/png');
  }
  expect((await page.request.get('/favicon.ico')).status()).toBe(200);
});
