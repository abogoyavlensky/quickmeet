// The remote video keeps its own shape: tall or wide, it is shown whole.
// A tall sender is the fake camera replaced by a canvas (tallCamera).
import { test, expect } from '@playwright/test';
import { newRoom, joinAs, tallCamera } from './helpers.js';

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
