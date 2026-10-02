// Screen sharing: a shared screen takes the other side's stage, shown
// whole, and the camera comes back when it ends. The screen is a canvas
// (canvasScreen); its shape is what tells it apart from the 16:9 fake
// camera.
import { test, expect } from '@playwright/test';
import { newRoom, joinAs, statsOf, canvasScreen, noScreen } from './helpers.js';

const ratioOf = page => page.evaluate(() => {
  const v = document.getElementById('remote');
  return v.videoHeight ? v.videoWidth / v.videoHeight : 0;
});
const remoteScreen = page => page.evaluate(() => window.call.remoteScreen);
const fitOf = page => page.evaluate(() => getComputedStyle(document.getElementById('remote')).objectFit);
const tileOf = page => page.locator('.tile:not(.self)');
const share = (page, on) => page.evaluate(on => window.call.room.localParticipant.setScreenShareEnabled(on), on);
const near = (want) => async page => Math.abs((await ratioOf(page)) / want - 1) < 0.02;

// Frames keep arriving for what the stage shows now.
async function expectFrames(page) {
  await expect.poll(async () => (await statsOf(page)).video !== null).toBe(true);
  const before = (await statsOf(page)).video.framesDecoded;
  await expect.poll(async () => (await statsOf(page)).video.framesDecoded).toBeGreaterThan(before);
}

test.describe('the other side shares a screen', () => {
  let contexts;
  test.beforeEach(() => { contexts = []; });
  test.afterEach(async () => { await Promise.all(contexts.map(c => c.close())); });

  test('a shared screen takes the stage, and the camera comes back after', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice', { init: canvasScreen(800, 600) });
    const bob = await joinAs(browser, contexts, roomUrl, 'bob');
    await expect.poll(() => near(16 / 9)(bob.page)).toBe(true);
    expect(await remoteScreen(bob.page)).toBe(false);

    await share(alice.page, true);
    await expect.poll(() => near(4 / 3)(bob.page)).toBe(true);
    await expect(tileOf(bob.page)).toHaveClass(/\bscreen\b/);
    expect(await remoteScreen(bob.page)).toBe(true);
    await expectFrames(bob.page);

    await share(alice.page, false);
    await expect.poll(() => near(16 / 9)(bob.page)).toBe(true);
    await expect(tileOf(bob.page)).not.toHaveClass(/\bscreen\b/);
    expect(await remoteScreen(bob.page)).toBe(false);
    await expectFrames(bob.page);
  });

  // Whichever of the camera and the screen is subscribed first, the screen
  // wins. With the camera off, the camera track is there but sends nothing.
  for (const camera of ['on', 'off']) {
    test(`someone who joins during a share sees the screen (camera ${camera})`, async ({ browser, page }) => {
      const roomUrl = await newRoom(page);
      const alice = await joinAs(browser, contexts, roomUrl, 'alice', { init: canvasScreen(800, 600) });
      if (camera === 'off') await alice.page.click('#cam');
      await share(alice.page, true);
      const bob = await joinAs(browser, contexts, roomUrl, 'bob');
      await expect.poll(() => near(4 / 3)(bob.page)).toBe(true);
      await expect(tileOf(bob.page)).toHaveClass(/\bscreen\b/);
      expect(await fitOf(bob.page)).toBe('contain');
      expect(await remoteScreen(bob.page)).toBe(true);
    });
  }

  test('the sharer leaving clears the stage', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice', { init: canvasScreen(800, 600) });
    const bob = await joinAs(browser, contexts, roomUrl, 'bob');
    await share(alice.page, true);
    await expect.poll(() => remoteScreen(bob.page)).toBe(true);

    await alice.page.click('#leave');
    await expect(bob.page.locator('#remote-name')).toHaveText('the other side left', { timeout: 10_000 });
    await expect(tileOf(bob.page)).not.toHaveClass(/\bscreen\b/);
    await expect(tileOf(bob.page)).toHaveClass(/\bempty\b/);
    expect(await remoteScreen(bob.page)).toBe(false);
  });
});

// On a phone lying sideways a 16:9 camera fills the screen (it crops
// nothing); a 16:9 screen of the same shape is still shown whole.
test.describe('on a phone lying sideways', () => {
  const sideways = { viewport: { width: 667, height: 375 }, isMobile: true, hasTouch: true };
  test.use(sideways);
  let contexts;
  test.beforeEach(() => { contexts = []; });
  test.afterEach(async () => { await Promise.all(contexts.map(c => c.close())); });

  test('a screen is never cropped', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice', { init: canvasScreen(1280, 720) });
    const bob = await joinAs(browser, contexts, roomUrl, 'bob', sideways);
    await expect.poll(() => fitOf(bob.page)).toBe('cover');

    await share(alice.page, true);
    await expect.poll(() => remoteScreen(bob.page)).toBe(true);
    await expect.poll(() => fitOf(bob.page)).toBe('contain');

    await share(alice.page, false);
    await expect.poll(() => remoteScreen(bob.page)).toBe(false);
    await expect.poll(() => fitOf(bob.page)).toBe('cover');
  });
});

// The sharer's side: the button, what it says, and the status line.
test.describe('sharing from a desktop', () => {
  const desktop = { viewport: { width: 1280, height: 800 } };
  let contexts;
  test.beforeEach(() => { contexts = []; });
  test.afterEach(async () => { await Promise.all(contexts.map(c => c.close())); });

  const sharingOf = page => page.evaluate(() => window.call.sharing);
  const expectButton = async (page, on) => {
    const button = page.locator('#share');
    await expect(button).toHaveAttribute('aria-label', on ? 'Stop sharing' : 'Share screen');
    await expect(button).toHaveAttribute('aria-pressed', String(on));
    if (on) await expect(button).toHaveAttribute('data-on', ''); else await expect(button).not.toHaveAttribute('data-on');
  };

  test('the button shares and stops', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice', { ...desktop, init: canvasScreen(800, 600) });
    const bob = await joinAs(browser, contexts, roomUrl, 'bob');
    await expect(alice.page.locator('#share')).toBeVisible();
    await expectButton(alice.page, false);

    await alice.page.click('#share');
    await expectButton(alice.page, true);
    await expect(alice.page.locator('#status')).toHaveText('You are sharing your screen.');
    expect(await sharingOf(alice.page)).toBe(true);
    await expect.poll(() => remoteScreen(bob.page)).toBe(true);
    // The sharer's stage still shows the other person, not their own screen.
    await expect.poll(() => near(16 / 9)(alice.page)).toBe(true);
    expect(await remoteScreen(alice.page)).toBe(false);

    await alice.page.click('#share');
    await expectButton(alice.page, false);
    await expect(alice.page.locator('#status')).toBeHidden();
    expect(await sharingOf(alice.page)).toBe(false);
    await expect.poll(() => remoteScreen(bob.page)).toBe(false);
  });

  // The browser's own "Stop sharing" bar ends the captured track; the
  // client listens for that `ended` event.
  test('a share ended by the browser turns the button off', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice', { ...desktop, init: canvasScreen(800, 600) });
    const bob = await joinAs(browser, contexts, roomUrl, 'bob');
    await alice.page.click('#share');
    await expectButton(alice.page, true);
    await expect.poll(() => remoteScreen(bob.page)).toBe(true);

    await alice.page.evaluate(() => {
      const pub = window.call.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.ScreenShare);
      pub.track.mediaStreamTrack.dispatchEvent(new Event('ended'));
    });
    await expectButton(alice.page, false);
    await expect(alice.page.locator('#status')).toBeHidden();
    expect(await sharingOf(alice.page)).toBe(false);
    await expect.poll(() => remoteScreen(bob.page)).toBe(false);
  });

  test('a closed picker is not an error', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice', { ...desktop, init: noScreen });
    await joinAs(browser, contexts, roomUrl, 'bob');
    await expect(alice.page.locator('#status')).toBeHidden();

    await alice.page.click('#share');
    await expectButton(alice.page, false);
    await expect(alice.page.locator('#share')).toBeEnabled();
    await expect(alice.page.locator('#status')).toBeHidden();
    expect(await sharingOf(alice.page)).toBe(false);
  });

  test('sharing alone keeps the waiting line', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice', { ...desktop, init: canvasScreen(800, 600) });
    await alice.page.click('#share');
    await expectButton(alice.page, true);
    await expect(alice.page.locator('#status')).toHaveText('Waiting for the other person.');

    await joinAs(browser, contexts, roomUrl, 'bob');
    await expect(alice.page.locator('#status')).toHaveText('You are sharing your screen.');
  });
});

// Mobile browsers cannot capture the screen (Android's refuse every call),
// so a phone has no button; it can still watch.
test.describe('on a phone', () => {
  const android = {
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  };
  test.use(android);
  let contexts;
  test.beforeEach(() => { contexts = []; });
  test.afterEach(async () => { await Promise.all(contexts.map(c => c.close())); });

  test('there is no share button', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice', android);
    await expect(alice.page.locator('#mic')).toBeVisible();
    await expect(alice.page.locator('#share')).toBeHidden();
  });
});
