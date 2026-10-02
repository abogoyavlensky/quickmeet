// The lobby: what a person sees before joining.
import { test, expect } from '@playwright/test';
import { newRoom, openLobby, joinAs, remoteOf, statsOf } from './helpers.js';

test.describe('the lobby', () => {
  let contexts;
  test.beforeEach(() => { contexts = []; });
  test.afterEach(async () => { await Promise.all(contexts.map(c => c.close())); });

  test('an unknown link says so', async ({ page }) => {
    await page.goto('/room/000000000000');
    await expect(page.locator('#gone')).toBeVisible();
    await expect(page.locator('#gone')).toContainText('does not exist');
    await expect(page.locator('#lobby')).toBeHidden();
    // No camera was asked for.
    expect(await page.evaluate(() => document.getElementById('preview').videoWidth)).toBe(0);
  });

  test('the lobby previews the camera and lists the devices', async ({ page }) => {
    await newRoom(page);
    await expect.poll(() => page.evaluate(() => document.getElementById('preview').videoWidth)).toBeGreaterThan(0);
    for (const id of ['#cam-select', '#mic-select']) {
      const labels = await page.locator(`${id} option`).allTextContents();
      expect(labels.length, `${id} options`).toBeGreaterThan(0);
      for (const l of labels) expect(l.trim()).not.toBe('');
    }
    // Switching devices keeps the preview playing.
    for (const id of ['#cam-select', '#mic-select']) {
      const last = await page.locator(`${id} option`).last().getAttribute('value');
      await page.selectOption(id, last);
    }
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => document.getElementById('preview').videoWidth)).toBeGreaterThan(0);
    await expect(page.locator('#error')).toBeHidden();
  });

  test('the microphone and the camera can be turned off before joining', async ({ page }) => {
    await newRoom(page);
    const preview = () => page.evaluate(() => document.getElementById('preview').videoWidth);
    const capture = kind => page.evaluate(k => trackOfKind(k).mediaStreamTrack.readyState, kind);
    await expect.poll(preview).toBeGreaterThan(0);
    await expect(page.locator('#cam-preview')).toBeVisible();
    await expect(page.locator('#mic-preview')).toBeVisible();

    // Camera off: the capture stops and the preview says so.
    await page.click('#cam-preview');
    await expect(page.locator('#cam-preview')).toHaveAttribute('data-off', '');
    await expect(page.locator('#cam-preview')).toHaveAttribute('aria-label', 'Start video');
    await expect(page.locator('.preview')).toHaveClass(/cam-off/);
    await expect(page.locator('.cam-off-label')).toBeVisible();
    expect(await capture('video')).toBe('ended');
    await expect(page.locator('#cam-select')).toBeDisabled();
    if (await page.locator('#blur-preview').isVisible()) await expect(page.locator('#blur-preview')).toBeDisabled();

    // Back on: the preview plays again.
    await page.click('#cam-preview');
    await expect(page.locator('#cam-preview')).not.toHaveAttribute('data-off');
    await expect(page.locator('#cam-preview')).toHaveAttribute('aria-label', 'Stop video');
    await expect(page.locator('.preview')).not.toHaveClass(/cam-off/);
    await expect(page.locator('.cam-off-label')).toBeHidden();
    expect(await capture('video')).toBe('live');
    await expect.poll(preview).toBeGreaterThan(0);
    await expect(page.locator('#cam-select')).toBeEnabled();

    // Microphone off and on.
    await page.click('#mic-preview');
    await expect(page.locator('#mic-preview')).toHaveAttribute('data-off', '');
    await expect(page.locator('#mic-preview')).toHaveAttribute('aria-label', 'Unmute');
    await expect(page.locator('#mic-select')).toBeDisabled();
    await page.click('#mic-preview');
    await expect(page.locator('#mic-preview')).not.toHaveAttribute('data-off');
    await expect(page.locator('#mic-preview')).toHaveAttribute('aria-label', 'Mute');
    await expect(page.locator('#mic-select')).toBeEnabled();
    await expect(page.locator('#error')).toBeHidden();
  });

  test('joining with both off publishes nothing until they are turned on', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const { page: alice } = await openLobby(browser, contexts, roomUrl, 'alice');
    for (const id of ['#mic-preview', '#cam-preview']) {
      await alice.click(id);
      await expect(alice.locator(id)).toHaveAttribute('data-off', '');
    }
    await alice.click('#join');
    await alice.waitForFunction(() => window.call.joined === true, null, { timeout: 15_000 });
    const bob = await joinAs(browser, contexts, roomUrl, 'bob');
    await expect.poll(() => remoteOf(alice)).toBe('bob');

    // Alice joined muted and without video, and says so.
    await expect(alice.locator('#mic')).toHaveAttribute('data-off', '');
    await expect(alice.locator('#cam')).toHaveAttribute('data-off', '');
    await expect(alice.locator('.tile.self')).toBeHidden();

    // She still sees and hears bob.
    const frames = async p => ((await statsOf(p)).video || {}).framesDecoded || 0;
    const packets = async p => ((await statsOf(p)).audio || {}).packetsReceived || 0;
    const aliceFrames = await frames(alice);
    await expect.poll(() => frames(alice)).toBeGreaterThan(aliceFrames);
    await expect.poll(() => packets(alice)).toBeGreaterThan(0);

    // Bob gets nothing from her.
    const before = await frames(bob.page), silent = await packets(bob.page);
    await new Promise(r => setTimeout(r, 2000));
    expect(await frames(bob.page)).toBe(before);
    expect(await packets(bob.page)).toBe(silent);

    // Turned on from the call, both reach bob.
    await alice.click('#cam');
    await alice.click('#mic');
    await expect(alice.locator('#cam')).not.toHaveAttribute('data-off');
    await expect(alice.locator('#mic')).not.toHaveAttribute('data-off');
    await expect(alice.locator('.tile.self')).toBeVisible();
    await expect.poll(() => frames(bob.page)).toBeGreaterThan(before);
    await expect.poll(() => packets(bob.page)).toBeGreaterThan(silent);
  });

  test('the lobby shows who is already here', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    await expect(page.locator('#presence')).toContainText('Nobody has joined yet');
    await joinAs(browser, contexts, roomUrl, 'alice');
    await expect(page.locator('#presence')).toContainText('alice is already here');
    await expect(page.locator('#join')).toBeEnabled();
  });

  test('a third person is told the meeting is full', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice');
    const bob = await joinAs(browser, contexts, roomUrl, 'bob');
    await expect.poll(() => remoteOf(alice.page)).toBe('bob');

    const carol = await openLobby(browser, contexts, roomUrl, 'carol');
    await expect(carol.page.locator('#presence')).toContainText('already has two people');
    await expect(carol.page.locator('#join')).toBeDisabled();
    const status = await carol.page.evaluate(async () => {
      const res = await fetch(location.pathname.replace('/room/', '/api/rooms/') + '/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      return res.status;
    });
    expect(status).toBe(409);

    // The call is untouched.
    expect(await remoteOf(alice.page)).toBe('bob');
    expect(await remoteOf(bob.page)).toBe('alice');
  });
});
