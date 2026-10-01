// The layout on a phone: a portrait touch viewport, checked by bounding
// boxes. The fixture page gets these settings from test.use; a participant
// the helper creates gets them through its context options.
import { test, expect } from '@playwright/test';
import { newRoom, joinAs, remoteOf, box, inside, overlaps } from './helpers.js';

const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
test.use(phone);

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

// Landscape is short: the thumbnail, the banner and the sound button must
// all fit above the controls.
test.describe('on a phone held sideways', () => {
  const landscape = { ...phone, viewport: { width: 667, height: 375 } };
  test.use(landscape);
  let contexts;
  test.beforeEach(() => { contexts = []; });
  test.afterEach(async () => { await Promise.all(contexts.map(c => c.close())); });

  test('the banner, the sound button and the controls all fit', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice', landscape);
    await joinAs(browser, contexts, roomUrl, 'bob');
    await expect.poll(() => remoteOf(alice.page)).toBe('bob');
    // Force both overlay elements on, as a waiting call on iOS would.
    await alice.page.evaluate(() => {
      document.getElementById('status').textContent = 'Waiting for the other person. Share the link.';
      document.getElementById('status').hidden = false;
      document.getElementById('sound').hidden = false;
    });

    const self = await box(alice.page.locator('.tile.self'));
    const boxes = {};
    for (const id of ['#status', '#sound', '#mic', '#cam', '#leave']) {
      boxes[id] = await box(alice.page.locator(id));
      expect(inside(boxes[id], 667, 375), `${id} inside the viewport: ${JSON.stringify(boxes[id])}`).toBe(true);
      expect(overlaps(boxes[id], self), `${id} clear of the self view`).toBe(false);
    }
    for (const id of ['#status', '#sound']) {
      for (const control of ['#mic', '#cam', '#leave']) {
        expect(overlaps(boxes[id], boxes[control]), `${id} clear of ${control}`).toBe(false);
      }
    }
  });
});

// A short desktop window keeps the desktop layout; the tile must give way
// to the controls instead of reaching under them or being clipped.
test.describe('in a short desktop window', () => {
  const short = { viewport: { width: 1280, height: 550 } };
  test.use(short);
  let contexts;
  test.beforeEach(() => { contexts = []; });
  test.afterEach(async () => { await Promise.all(contexts.map(c => c.close())); });

  test('the remote tile, its name and the controls all fit', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice', short);
    await joinAs(browser, contexts, roomUrl, 'bob');
    await expect.poll(() => remoteOf(alice.page)).toBe('bob');
    for (const id of ['#remote', '#remote-name', '.tile.self', '#mic', '#cam', '#leave']) {
      const b = await box(alice.page.locator(id));
      expect(inside(b, 1280, 550), `${id} inside the viewport: ${JSON.stringify(b)}`).toBe(true);
    }
    const remote = await box(alice.page.locator('#remote'));
    const leave = await box(alice.page.locator('#leave'));
    expect(overlaps(remote, leave), 'the tile stops above the controls').toBe(false);
  });
});
