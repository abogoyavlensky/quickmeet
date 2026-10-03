// Switching devices in a call: the switch-camera button in the controls
// (a phone flips front and back, a desktop moves to the next camera), and
// on a desktop the settings panel in the bar with a camera and a
// microphone picker. The headless shell has one camera, so twoCameras
// adds a back one; it is a 4:3 canvas, and the other side tells it from
// the 16:9 fake camera by shape.
import { test, expect } from '@playwright/test';
import { newRoom, openLobby, joinAs, remoteOf, statsOf, box, inside, overlaps, twoCameras } from './helpers.js';

const ratioOf = page => page.evaluate(() => {
  const v = document.getElementById('remote');
  return v.videoHeight ? v.videoWidth / v.videoHeight : 0;
});
const sourceOf = (page, kind) => page.evaluate(k => trackOfKind(k).getSourceTrackSettings(), kind);
const facingOf = async page => (await sourceOf(page, 'video')).facingMode || null;
const framesOf = async page => ((await statsOf(page)).video || {}).framesDecoded || 0;
const packetsOf = async page => ((await statsOf(page)).audio || {}).packetsReceived || 0;
// What the other side receives keeps growing past what it has now.
async function keepsComing(page, count) {
  const before = await count(page);
  await expect.poll(() => count(page)).toBeGreaterThan(before);
}
const FRONT = 16 / 9, BACK = 4 / 3;

test.describe('on a phone', () => {
  const android = {
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  };
  test.use(android);
  let contexts;
  test.beforeEach(() => { contexts = []; });
  test.afterEach(async () => { await Promise.all(contexts.map(c => c.close())); });

  test('the switch flips to the back camera and back', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice', { ...android, init: twoCameras() });
    const bob = await joinAs(browser, contexts, roomUrl, 'bob');
    await expect.poll(() => remoteOf(bob.page)).toBe('alice');
    await expect.poll(() => ratioOf(bob.page)).toBeCloseTo(FRONT, 1);

    const a = alice.page;
    const button = a.locator('#switch-cam');
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-label', 'Flip camera');
    await expect(a.locator('#more')).toBeHidden();

    // Blur sits on the self view, the switch in the controls clear of it.
    const self = await box(a.locator('.tile.self'));
    const blur = await box(a.locator('#blur'));
    expect(inside({ ...blur, x: blur.x - self.x, y: blur.y - self.y }, self.width, self.height), 'blur inside the self view').toBe(true);
    expect(blur.height).toBeGreaterThanOrEqual(40);
    const flip = await box(button);
    expect(inside(flip, 390, 844), 'switch inside the viewport').toBe(true);
    expect(overlaps(flip, self), 'switch clear of the self view').toBe(false);

    await button.click();
    await expect.poll(() => facingOf(a)).toBe('environment');
    await expect(a.locator('body')).toHaveClass(/rear-camera/);
    expect(await a.evaluate(() => getComputedStyle(document.getElementById('local')).transform)).toBe('none');
    await expect.poll(() => ratioOf(bob.page)).toBeCloseTo(BACK, 1);
    await keepsComing(bob.page, framesOf);

    await button.click();
    await expect.poll(() => facingOf(a)).not.toBe('environment');
    await expect(a.locator('body')).not.toHaveClass(/rear-camera/);
    await expect.poll(() => ratioOf(bob.page)).toBeCloseTo(FRONT, 1);
  });

  test('a camera that cannot start leaves the old one running', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice', { ...android, init: twoCameras({ backFails: true }) });
    const bob = await joinAs(browser, contexts, roomUrl, 'bob');
    await expect.poll(() => remoteOf(bob.page)).toBe('alice');
    const a = alice.page;

    await a.locator('#switch-cam').click();
    await expect(a.locator('#status')).toHaveText('Could not switch camera.');
    expect(await facingOf(a)).not.toBe('environment');
    await expect(a.locator('body')).not.toHaveClass(/rear-camera/);
    await expect.poll(() => a.evaluate(() => trackOfKind('video').mediaStreamTrack.readyState)).toBe('live');
    await keepsComing(bob.page, framesOf);
  });

  for (const backFails of [false, true]) {
    test(`leaving during a switch leaves no camera running (switch ${backFails ? 'fails' : 'works'})`, async ({ browser, page }) => {
      const roomUrl = await newRoom(page);
      const alice = await joinAs(browser, contexts, roomUrl, 'alice', { ...android, init: twoCameras({ backFails, backDelay: 2000 }) });
      const a = alice.page;
      await a.evaluate(() => { window.__before = trackOfKind('video'); });

      await a.locator('#switch-cam').click();
      await a.locator('#leave').click();
      await expect(a.locator('#lobby')).toBeVisible();
      await expect.poll(() => a.evaluate(() => document.getElementById('preview').videoWidth)).toBeGreaterThan(0);

      // The switch is still in flight: the lobby's camera button waits for
      // it. Only once it has ended does the old track's state say anything.
      await expect(a.locator('#cam-preview')).toBeDisabled();
      await expect(a.locator('#cam-preview')).toBeEnabled({ timeout: 10_000 });
      expect(await a.evaluate(() => window.__before.mediaStreamTrack.readyState)).toBe('ended');
      expect(await a.evaluate(() => trackOfKind('video') !== window.__before)).toBe(true);
      await expect(a.locator('#error')).toBeHidden();
    });
  }
});

test.describe('on a desktop', () => {
  const desktop = { viewport: { width: 1280, height: 800 } };
  test.use(desktop);
  let contexts;
  test.beforeEach(() => { contexts = []; });
  test.afterEach(async () => { await Promise.all(contexts.map(c => c.close())); });

  test('the switch moves to the next camera', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const { page: a } = await openLobby(browser, contexts, roomUrl, 'alice', { ...desktop, init: twoCameras() });
    await expect.poll(() => a.evaluate(() => document.getElementById('preview').videoWidth)).toBeGreaterThan(0);
    await expect(a.locator('#cam-select option')).toHaveCount(2);
    // While the join publishes, the camera cannot be switched.
    await a.click('#join');
    await expect(a.locator('#cam-select')).toBeDisabled();
    await a.waitForFunction(() => window.call.joined === true, null, { timeout: 15_000 });
    await expect(a.locator('#cam-select')).toBeEnabled();

    const bob = await joinAs(browser, contexts, roomUrl, 'bob');
    await expect.poll(() => ratioOf(bob.page)).toBeCloseTo(FRONT, 1);
    const button = a.locator('#switch-cam');
    await expect(button).toHaveAttribute('aria-label', 'Switch camera');
    const front = (await sourceOf(a, 'video')).deviceId;

    await button.click();
    await expect.poll(async () => (await sourceOf(a, 'video')).deviceId).toBe('back');
    await expect.poll(() => ratioOf(bob.page)).toBeCloseTo(BACK, 1);
    await expect(a.locator('#cam-select')).toHaveValue('back');
    await expect(a.locator('#cam-pick')).toHaveValue('back');

    await button.click();
    await expect.poll(async () => (await sourceOf(a, 'video')).deviceId).toBe(front);
    await expect.poll(() => ratioOf(bob.page)).toBeCloseTo(FRONT, 1);

    // Camera off: no self view, nothing to switch. Back on: both return.
    await a.click('#cam');
    await expect(a.locator('.tile.self')).toBeHidden();
    await expect(button).toBeDisabled();
    await a.click('#cam');
    await expect(a.locator('.tile.self')).toBeVisible();
    await expect(button).toBeEnabled();
  });

  test('with one camera there is nothing to switch', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice', desktop);
    await expect(alice.page.locator('#switch-cam')).toBeHidden();
    await expect(alice.page.locator('#more')).toBeVisible();
  });

  test('the settings panel picks a camera and a microphone', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice', { ...desktop, init: twoCameras() });
    const bob = await joinAs(browser, contexts, roomUrl, 'bob');
    await expect.poll(() => ratioOf(bob.page)).toBeCloseTo(FRONT, 1);
    const a = alice.page;
    const more = a.locator('#more'), panel = a.locator('#settings');

    await expect(more).toBeVisible();
    await expect(panel).toBeHidden();
    await more.click();
    await expect(panel).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(a.locator('#cam-pick option')).toHaveCount(2);
    await expect(a.locator('#cam-pick option:checked')).toHaveText('fake_device_0');
    const mics = await a.locator('#mic-pick option').evaluateAll(os => os.map(o => o.value));
    expect(mics.length).toBeGreaterThan(1);

    await a.selectOption('#cam-pick', 'back');
    await expect.poll(async () => (await sourceOf(a, 'video')).deviceId).toBe('back');
    await expect.poll(() => ratioOf(bob.page)).toBeCloseTo(BACK, 1);

    const mic = mics[mics.length - 1];
    await a.selectOption('#mic-pick', mic);
    await expect.poll(async () => (await sourceOf(a, 'audio')).deviceId).toBe(mic);
    await keepsComing(bob.page, packetsOf);
    await expect(a.locator('#mic-select')).toHaveValue(mic);

    await a.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(more).toHaveAttribute('aria-expanded', 'false');

    await more.click();
    await expect(panel).toBeVisible();
    await a.locator('#remote').click();
    await expect(panel).toBeHidden();

    await more.click();
    await expect(panel).toBeVisible();
    await a.click('#leave');
    await expect(a.locator('#lobby')).toBeVisible();
    await expect(panel).toBeHidden();
    await expect(more).toBeHidden();
  });
});

// Safari on an iPad says it is a Mac. A touch screen tells them apart, so
// an iPad flips by facing like a phone instead of going through its
// several back cameras in turn.
test.describe('on an iPad', () => {
  const ipad = {
    viewport: { width: 820, height: 1180 }, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  };
  const touchScreen = async context => {
    await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5 }));
  };
  test.use(ipad);
  let contexts;
  test.beforeEach(() => { contexts = []; });
  test.afterEach(async () => { await Promise.all(contexts.map(c => c.close())); });

  test('the switch flips, and there is no settings panel', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice', {
      ...ipad, init: async context => { await touchScreen(context); await twoCameras()(context); },
    });
    await expect(alice.page.locator('#switch-cam')).toHaveAttribute('aria-label', 'Flip camera');
    await expect(alice.page.locator('#more')).toBeHidden();
    await alice.page.locator('#switch-cam').click();
    await expect.poll(() => facingOf(alice.page)).toBe('environment');
  });
});
