// Background blur: the button on the lobby's preview and the one in the
// controls, against the built binary, so the wasm and the model the page
// loads are the ones embedded in it.
//
// Blur runs on software WebGL in the headless shell, at about a frame a
// second, and keeps the main thread so busy that animation frames are rare.
// Playwright waits for two of them before a click ("stable"), so a click
// while blur runs is forced, waits poll on a timer, and frame counts are
// polled for growth, never for a rate. Several of these at once starve
// each other: to repeat the file, use one worker.
import { test, expect } from '@playwright/test';
import { newRoom, openLobby, joinAs, statsOf } from './helpers.js';

const blurOf = page => page.evaluate(() => window.call.blur);
const remembered = page => page.evaluate(() => localStorage.getItem('quickmeet.blur'));
const framesAt = async page => ((await statsOf(page)).video || {}).framesDecoded || 0;
// The other side keeps receiving: its decoded frames grow past `from`.
const framesGrow = async (page, from) =>
  expect.poll(() => framesAt(page), { timeout: 30_000 }).toBeGreaterThan(from);
const SLOW = { timeout: 30_000 };
// waitForFunction polls on animation frames unless told otherwise.
const POLL = { timeout: 30_000, polling: 500 };

test.describe('background blur', () => {
  let contexts;
  test.beforeEach(() => { contexts = []; });
  test.afterEach(async () => { await Promise.all(contexts.map(c => c.close())); });

  test('on in the lobby, remembered, and kept through a camera switch', async ({ browser, page }) => {
    test.setTimeout(120_000);
    const roomUrl = await newRoom(page);
    const { page: alice } = await openLobby(browser, contexts, roomUrl, 'alice');

    await expect(alice.locator('#blur-preview')).toBeVisible();
    await alice.click('#blur-preview');
    await expect.poll(() => blurOf(alice), SLOW).toBe(true);
    await expect(alice.locator('#blur-preview')).toHaveAttribute('aria-pressed', 'true');
    expect(await remembered(alice)).toBe('1');
    await expect.poll(() => alice.evaluate(() => document.getElementById('preview').videoWidth)).toBeGreaterThan(0);

    // The next lobby on this device starts blurred, and the camera select
    // still shows the camera in use (it is filled before blur goes on).
    await alice.reload();
    await expect.poll(() => blurOf(alice), SLOW).toBe(true);
    expect(await alice.evaluate(() => {
      const current = trackOfKind(Track.Kind.Video).getSourceTrackSettings().deviceId;
      return document.getElementById('cam-select').value === current;
    })).toBe(true);

    // Another camera: the processor restarts with the track.
    const last = await alice.locator('#cam-select option').last().getAttribute('value');
    await alice.selectOption('#cam-select', last);
    await alice.waitForTimeout(1000);
    expect(await blurOf(alice)).toBe(true);
    await expect(alice.locator('#error')).toBeHidden();
  });

  test('blurred into the call, through camera off and on, and off again', async ({ browser, page }) => {
    test.setTimeout(120_000);
    const roomUrl = await newRoom(page);
    const { page: alice } = await openLobby(browser, contexts, roomUrl, 'alice');
    await alice.click('#blur-preview');
    await expect.poll(() => blurOf(alice), SLOW).toBe(true);

    await alice.click('#join', { force: true });
    await alice.waitForFunction(() => window.call.joined === true, null, POLL);
    expect(await blurOf(alice)).toBe(true);
    const { page: bob } = await joinAs(browser, contexts, roomUrl, 'bob');
    await framesGrow(bob, 0);
    await framesGrow(bob, await framesAt(bob));

    // Camera off: nothing to blur, the button waits. Back on: still blurred.
    await alice.click('#cam', { force: true });
    await expect(alice.locator('#blur')).toBeDisabled();
    await alice.click('#cam', { force: true });
    await expect(alice.locator('#blur')).toBeEnabled(SLOW);
    expect(await blurOf(alice)).toBe(true);

    await alice.click('#blur', { force: true });
    await expect.poll(() => blurOf(alice), SLOW).toBe(false);
    await expect(alice.locator('#blur')).toHaveAttribute('aria-pressed', 'false');
    expect(await remembered(alice)).toBeNull();
    await framesGrow(bob, await framesAt(bob));
  });

  test('when the wasm does not load, the camera goes on unblurred', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const init = context => context.route('**/vision_wasm_internal.wasm', route => route.abort());
    const { page: alice } = await openLobby(browser, contexts, roomUrl, 'alice', { init });

    await alice.click('#blur-preview');
    await expect(alice.locator('#notice')).toContainText('not available', SLOW);
    await expect(alice.locator('#blur-preview')).toBeEnabled();
    await expect(alice.locator('#blur-preview')).toHaveAttribute('aria-pressed', 'false');
    expect(await blurOf(alice)).toBe(false);
    expect(await remembered(alice)).toBeNull();

    await alice.click('#join');
    await alice.waitForFunction(() => window.call.joined === true, null, POLL);
  });

  test('a join right after the click waits for blur, and publishes blurred', async ({ browser, page }) => {
    test.setTimeout(90_000);
    const roomUrl = await newRoom(page);
    // Slow enough that, without the wait, the camera would be published
    // before the processor is ready.
    const init = context => context.route('**/vision_wasm_internal.wasm', async route => {
      await new Promise(resolve => setTimeout(resolve, 2000));
      await route.continue();
    });
    const { page: alice } = await openLobby(browser, contexts, roomUrl, 'alice', { init });
    // Record whether the camera had its processor at the moment it was
    // published.
    await alice.evaluate(() => {
      const proto = LivekitClient.LocalParticipant.prototype;
      const publish = proto.publishTrack;
      window.publishedBlurred = null;
      proto.publishTrack = function (track, ...rest) {
        if (track.kind === 'video') window.publishedBlurred = !!track.getProcessor();
        return publish.call(this, track, ...rest);
      };
    });

    await alice.click('#blur-preview');
    await alice.click('#join', { force: true });
    await alice.waitForFunction(() => window.call.joined === true, null, POLL);
    expect(await alice.evaluate(() => window.publishedBlurred)).toBe(true);
    expect(await blurOf(alice)).toBe(true);
  });

  test('while the wasm loads, the button says so; switching off does not', async ({ browser, page }) => {
    test.setTimeout(120_000);
    const roomUrl = await newRoom(page);
    // The wasm is held until the test lets it go, so the loading state is
    // there for as long as the assertions need, whatever fetched it first.
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const init = context => context.route('**/vision_wasm_internal.wasm', async route => {
      await held;
      await route.continue();
    });
    const { page: alice } = await openLobby(browser, contexts, roomUrl, 'alice', { init });
    const button = alice.locator('#blur-preview');
    await expect(button).toBeVisible();

    await alice.click('#blur-preview');
    await expect(button).toHaveAttribute('data-busy', '');
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toHaveAttribute('aria-label', 'Loading blur…');
    release();
    await expect.poll(() => blurOf(alice), SLOW).toBe(true);
    await expect(button).not.toHaveAttribute('data-busy');
    await expect(button).not.toHaveAttribute('aria-busy');
    await expect(button).toHaveAttribute('aria-label', 'Stop blurring');

    // Off is instant: no loading state on the way, at any moment.
    await alice.evaluate(() => {
      const b = document.getElementById('blur-preview');
      window.sawBusy = false;
      new MutationObserver(() => { if (b.hasAttribute('data-busy')) window.sawBusy = true; })
        .observe(b, { attributes: true });
    });
    await alice.click('#blur-preview', { force: true });
    await expect.poll(() => blurOf(alice), SLOW).toBe(false);
    expect(await alice.evaluate(() => window.sawBusy)).toBe(false);
    await expect(button).toHaveAttribute('aria-label', 'Blur background');
  });

  test('a browser that cannot blur shows no button', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const init = context => context.addInitScript(() => { delete window.VideoFrame; });
    const { page: alice } = await openLobby(browser, contexts, roomUrl, 'alice', { init });

    // The devices are listed once the tracks are in; the button would be
    // shown by then.
    await expect.poll(() => alice.locator('#cam-select option').count()).toBeGreaterThan(0);
    await expect(alice.locator('#blur-preview')).toBeHidden();
    await alice.click('#join');
    await alice.waitForFunction(() => window.call.joined === true, null, POLL);
    await expect(alice.locator('#blur')).toBeHidden();
  });
});
