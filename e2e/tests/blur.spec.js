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
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  test('a desktop lobby fetches the wasm before the click, a phone does not', async ({ browser, page }) => {
    test.setTimeout(120_000);
    const roomUrl = await newRoom(page);

    // The desktop half runs in a profile with a disk cache, as a real
    // browser has. Playwright's usual contexts are like private windows:
    // their cache lives in memory and never holds an entry this large
    // (checked 2026-10-04), so there every fetch of the wasm downloads it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quickmeet-profile-'));
    const desktop = await chromium.launchPersistentContext(dir, {
      baseURL: test.info().project.use.baseURL,
      permissions: ['camera', 'microphone'],
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    });
    try {
      const alice = desktop.pages()[0] || await desktop.newPage();
      await alice.goto(roomUrl);
      // What each fetch of the wasm took from the network.
      const wasm = () => alice.evaluate(() => performance.getEntriesByType('resource')
        .filter(e => /vision_wasm_internal\.wasm$/.test(e.name)).map(e => e.transferSize));
      await expect.poll(async () => (await wasm()).length, { timeout: 15_000 }).toBe(1);
      expect(await blurOf(alice)).toBe(false);
      await alice.click('#blur-preview');
      await expect.poll(() => blurOf(alice), SLOW).toBe(true);
      // The click found the wasm in the cache: nothing more downloaded.
      const sizes = await wasm();
      expect(sizes[0]).toBeGreaterThan(1_000_000);
      expect(sizes.slice(1).every(n => n === 0), `transfer sizes ${sizes}`).toBe(true);
    } finally {
      await desktop.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // Requests from the moment the context exists, so one the page makes
    // while it loads is not missed.
    const phone = [];
    const { page: bob } = await openLobby(browser, contexts, roomUrl, 'bob', {
      init: context => context.on('request', r => { if (/vision_wasm_internal\.wasm$/.test(r.url())) phone.push(r); }),
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
      isMobile: true,
      hasTouch: true,
      viewport: { width: 390, height: 844 },
    });
    await expect.poll(() => bob.evaluate(() => document.getElementById('preview').videoWidth)).toBeGreaterThan(0);
    await bob.waitForTimeout(3000);
    expect(phone.length).toBe(0);
  });

  test('blur switched off while its first frame waits does not freeze the page', async ({ browser, page }) => {
    test.setTimeout(120_000);
    const roomUrl = await newRoom(page);
    // The library's first processed frame waits for the video to paint
    // (requestVideoFrameCallback) before it segments. Delayed by 2 s, that
    // wait is a window to switch blur off in; the flag says it has begun.
    // Before the fix, the frame then went on into a closed segmenter and
    // the page froze for good.
    const init = context => context.addInitScript(() => {
      const real = HTMLVideoElement.prototype.requestVideoFrameCallback;
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
        window.firstFrameWaiting = true;
        return real.call(this, (...args) => setTimeout(() => callback(...args), 2000));
      };
    });
    const { page: alice } = await openLobby(browser, contexts, roomUrl, 'alice', { init });

    await alice.click('#blur-preview');
    await alice.waitForFunction(() => window.call.blur === true && window.firstFrameWaiting === true, null, POLL);
    await alice.evaluate(() => document.getElementById('blur-preview').click());
    await alice.waitForTimeout(4000);
    // A frozen page never answers, and Playwright's own timeout would not
    // come first.
    const answer = await Promise.race([
      alice.evaluate(() => 'answers'),
      new Promise(resolve => setTimeout(() => resolve('frozen'), 10_000)),
    ]);
    expect(answer).toBe('answers');
    expect(await blurOf(alice)).toBe(false);
    await alice.evaluate(() => document.getElementById('join').click());
    await alice.waitForFunction(() => window.call.joined === true, null, POLL);
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
