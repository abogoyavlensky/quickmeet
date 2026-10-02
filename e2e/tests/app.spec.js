// The app as installed to a home screen, where there is no address bar and
// no browser Back button: the manifest and its icons, a way back to the
// room list from every page that leads off it, and what stays in view.
import { test, expect } from '@playwright/test';
import { signUp, newRoom, box, overlaps } from './helpers.js';

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

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the menu and New call stay in view on a long list', async ({ page }) => {
    await signUp(page);
    // A full page of rooms (the list shows 20 at a time) is longer than
    // the screen.
    for (let i = 0; i < 20; i++) expect((await page.request.post('/api/rooms')).status()).toBe(201);
    await page.goto('/');
    await expect(page.locator('#rooms li')).toHaveCount(20);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    await expect(page.locator('#nav').getByRole('link', { name: 'History' })).toBeInViewport();
    await expect(page.locator('#new')).toBeInViewport();
    const bar = await box(page.locator('.bar'));
    const button = await box(page.locator('#new'));
    expect(bar.y).toBe(0);
    expect(button.y).toBeGreaterThanOrEqual(bar.y + bar.height);
    const last = page.locator('#rooms li').last();
    await expect(last).toBeInViewport();
    expect(overlaps(await box(last), button)).toBe(false);
  });
});
