// The layout on a phone: a portrait touch viewport, checked by bounding
// boxes. The fixture page gets these settings from test.use; a participant
// the helper creates gets them through its context options.
import { test, expect } from '@playwright/test';
import { newRoom, joinAs, remoteOf } from './helpers.js';

const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
test.use(phone);

const box = async locator => {
  const b = await locator.boundingBox();
  expect(b, `${locator} has a box`).not.toBeNull();
  return b;
};
const inside = (b, w, h) => b.x >= 0 && b.y >= 0 && b.x + b.width <= w + 0.5 && b.y + b.height <= h + 0.5;
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test.describe('on a phone', () => {
  let contexts;
  test.beforeEach(() => { contexts = []; });
  test.afterEach(async () => { await Promise.all(contexts.map(c => c.close())); });

  test('the lobby fits without scrolling', async ({ page }) => {
    await newRoom(page);
    await expect.poll(() => page.evaluate(() => document.getElementById('preview').videoWidth)).toBeGreaterThan(0);
    const join = await box(page.locator('#join'));
    expect(join.y + join.height).toBeLessThanOrEqual(844);
  });

  test('the call fills the screen and the controls are reachable', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice', phone);
    await joinAs(browser, contexts, roomUrl, 'bob');
    await expect.poll(() => remoteOf(alice.page)).toBe('bob');

    const remote = await box(alice.page.locator('#remote'));
    expect(remote.width).toBe(390);
    expect(remote.height).toBeGreaterThanOrEqual(500);

    const self = await box(alice.page.locator('.tile.self'));
    expect(inside(self, 390, 844), `self view inside the viewport: ${JSON.stringify(self)}`).toBe(true);
    expect(self.height).toBeLessThan(self.width * 2);

    for (const id of ['#mic', '#cam', '#leave']) {
      const b = await box(alice.page.locator(id));
      expect(inside(b, 390, 844), `${id} inside the viewport: ${JSON.stringify(b)}`).toBe(true);
      expect(b.height, `${id} tall enough to tap`).toBeGreaterThanOrEqual(44);
      expect(overlaps(b, self), `${id} clear of the self view`).toBe(false);
    }
    await expect(alice.page.locator('#copy')).toBeVisible();
  });
});
