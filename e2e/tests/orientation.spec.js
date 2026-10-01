// The remote video keeps its own shape: tall or wide, it is shown whole.
// A tall sender is the fake camera replaced by a canvas (tallCamera).
import { test, expect } from '@playwright/test';
import { newRoom, joinAs, tallCamera, webcam, box, inside, overlaps } from './helpers.js';

const desktop = { viewport: { width: 1280, height: 800 } };
const ratioOf = b => b.width / b.height;
const tileOf = page => page.locator('.tile:not(.self)');
const remoteRatio = async page => { const d = await dims(page, 'remote'); return d.w / d.h; };

const dims = (page, id) => page.evaluate(id => {
  const v = document.getElementById(id);
  return { w: v.videoWidth, h: v.videoHeight };
}, id);

test.describe('a camera held upright', () => {
  let contexts;
  test.beforeEach(() => { contexts = []; });
  test.afterEach(async () => { await Promise.all(contexts.map(c => c.close())); });

  test('a tall camera reaches the other side tall', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice');
    const bob = await joinAs(browser, contexts, roomUrl, 'bob', { init: tallCamera });
    await expect.poll(async () => (await dims(alice.page, 'remote')).w).toBeGreaterThan(0);
    const remote = await dims(alice.page, 'remote');
    expect(remote.h, JSON.stringify(remote)).toBeGreaterThan(remote.w);
    const local = await dims(bob.page, 'local');
    expect(local.h, JSON.stringify(local)).toBeGreaterThan(local.w);
  });
});

test.describe('on a desktop', () => {
  let contexts;
  test.beforeEach(() => { contexts = []; });
  test.afterEach(async () => { await Promise.all(contexts.map(c => c.close())); });

  // The tile has the video's shape (within 2%), fits the window and stops
  // above the controls.
  const expectFitted = async page => {
    const tile = await box(tileOf(page));
    const want = await remoteRatio(page);
    expect(Math.abs(ratioOf(tile) / want - 1), `tile ${JSON.stringify(tile)}, video ratio ${want}`).toBeLessThan(0.02);
    expect(inside(tile, 1280, 800), `tile inside the viewport: ${JSON.stringify(tile)}`).toBe(true);
    expect(overlaps(tile, await box(page.locator('#leave'))), 'the tile stops above the controls').toBe(false);
  };

  test('a tall video gets a tall tile, and 16:9 again when the other side leaves', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice', desktop);
    const bob = await joinAs(browser, contexts, roomUrl, 'bob', { init: tallCamera });
    await expect.poll(async () => { const b = await box(tileOf(alice.page)); return b.height > b.width; }).toBe(true);
    await expectFitted(alice.page);

    await bob.page.click('#leave');
    await expect(alice.page.locator('#remote-name')).toHaveText('the other side left', { timeout: 10_000 });
    await expect.poll(async () => ratioOf(await box(tileOf(alice.page)))).toBeCloseTo(16 / 9, 1);
  });

  test('a wide video gets a wide tile of its own shape', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice', desktop);
    await joinAs(browser, contexts, roomUrl, 'bob');
    await expect.poll(async () => (await dims(alice.page, 'remote')).w).toBeGreaterThan(0);
    const tile = await box(tileOf(alice.page));
    expect(tile.width).toBeGreaterThan(tile.height);
    await expectFitted(alice.page);
    // And it takes the window: nothing but the bar above and the controls
    // below limits it.
    expect(tile.height).toBeGreaterThan(800 - 56 - 88 - 2);
  });
});

// A phone's remote tile is the whole screen: the video fills it when that
// crops little (it has about the screen's shape) and is letterboxed, shown
// whole, when it does not. `wide` is the fake camera, 16:9, a sideways
// phone's own shape; `4:3` is a webcam's, which on a sideways phone would
// lose a quarter of the picture to filling.
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const sideways = { ...phone, viewport: { width: 667, height: 375 } };
const fitOf = page => page.evaluate(() => getComputedStyle(document.getElementById('remote')).objectFit);

const cameras = { wide: {}, tall: { init: tallCamera }, '4:3': { init: webcam } };
for (const [screen, options] of [['upright', phone], ['sideways', sideways]]) {
  for (const video of ['wide', 'tall', '4:3']) {
    const letterboxed = video === '4:3' || (screen === 'upright') === (video === 'wide');
    test.describe(`on a phone held ${screen}`, () => {
      test.use(options);
      let contexts;
      test.beforeEach(() => { contexts = []; });
      test.afterEach(async () => { await Promise.all(contexts.map(c => c.close())); });

      test(`a ${video} video is ${letterboxed ? 'letterboxed' : 'filling the screen'}`, async ({ browser, page }) => {
        const roomUrl = await newRoom(page);
        const alice = await joinAs(browser, contexts, roomUrl, 'alice', options);
        await joinAs(browser, contexts, roomUrl, 'bob', cameras[video]);
        await expect.poll(async () => alice.page.locator('.tile:not(.self)').getAttribute('class')).toContain(video === 'tall' ? 'tall' : 'wide');
        await expect.poll(() => fitOf(alice.page)).toBe(letterboxed ? 'contain' : 'cover');
        expect((await box(tileOf(alice.page))).width).toBe(options.viewport.width);
      });
    });
  }
}

test.describe('on a phone turned during a call', () => {
  test.use(phone);
  let contexts;
  test.beforeEach(() => { contexts = []; });
  test.afterEach(async () => { await Promise.all(contexts.map(c => c.close())); });

  test('a wide video goes from letterboxed to filling the screen', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice', phone);
    await joinAs(browser, contexts, roomUrl, 'bob');
    await expect.poll(() => fitOf(alice.page)).toBe('contain');
    await alice.page.setViewportSize(sideways.viewport);
    await expect.poll(() => fitOf(alice.page)).toBe('cover');
  });
});
