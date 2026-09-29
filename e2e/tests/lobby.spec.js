// The lobby: what a person sees before joining.
import { test, expect } from '@playwright/test';
import { newRoom, openLobby, joinAs, remoteOf } from './helpers.js';

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
