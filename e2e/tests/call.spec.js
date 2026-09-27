// A real call between two browsers through the SFU embedded in the binary.
// Each test creates its own room and its own participants, so tests do not
// depend on each other and retries or --repeat-each stay valid.
import { test, expect } from '@playwright/test';

// Open the landing page, click "New meeting", return the room URL.
async function newRoom(page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New meeting' }).click();
  await expect(page).toHaveURL(/\/room\/[0-9a-f]{12}$/);
  return page.url();
}

// A participant: its own browser context (own origin state, permissions and
// fake devices), joined to the room under `name`. Page errors and console
// errors are echoed into the test output.
async function joinAs(browser, contexts, roomUrl, name) {
  const context = await browser.newContext();
  contexts.push(context);
  await context.grantPermissions(['camera', 'microphone']);
  const page = await context.newPage();
  page.on('pageerror', e => console.log(`[${name}] pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') console.log(`[${name}] console.error: ${m.text()}`); });
  await page.goto(roomUrl);
  await page.fill('#identity', name);
  await page.click('#join');
  await page.waitForFunction(() => window.call.joined === true, null, { timeout: 15_000 });
  return { context, page };
}

const remoteOf = page => page.evaluate(() => window.call.remote);
const statsOf = page => page.evaluate(() => window.call.stats());

test.describe('a call between two participants', () => {
  let contexts;
  test.beforeEach(() => { contexts = []; });
  test.afterEach(async () => { await Promise.all(contexts.map(c => c.close())); });

  test('two participants see and hear each other', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice');
    const bob = await joinAs(browser, contexts, roomUrl, 'bob');

    // Each sees the other's identity, in the state and in the tag.
    await expect.poll(() => remoteOf(alice.page)).toBe('bob');
    await expect.poll(() => remoteOf(bob.page)).toBe('alice');
    await expect(alice.page.locator('#remote-name')).toHaveText('bob');
    await expect(bob.page.locator('#remote-name')).toHaveText('alice');

    // The remote video is playing on both sides.
    for (const { page } of [alice, bob]) {
      await expect.poll(() => page.evaluate(() => document.getElementById('remote').videoWidth)).toBeGreaterThan(0);
      await expect.poll(() => page.evaluate(() => document.getElementById('remote').readyState)).toBeGreaterThanOrEqual(2);
    }

    // Media flows both ways: video frames and audio packets keep arriving,
    // and nothing is lost. Video readiness says nothing about audio, so wait
    // for both inbound stats to exist first.
    for (const { page } of [alice, bob]) {
      await expect.poll(async () => {
        const s = await statsOf(page);
        return s.video !== null && s.audio !== null;
      }).toBe(true);
    }
    const before = { alice: await statsOf(alice.page), bob: await statsOf(bob.page) };
    await new Promise(r => setTimeout(r, 2000));
    const after = { alice: await statsOf(alice.page), bob: await statsOf(bob.page) };
    for (const who of ['alice', 'bob']) {
      expect(after[who].video.framesDecoded, `${who} video framesDecoded`).toBeGreaterThan(before[who].video.framesDecoded);
      expect(after[who].audio.packetsReceived, `${who} audio packetsReceived`).toBeGreaterThan(before[who].audio.packetsReceived);
      expect(after[who].video.packetsLost, `${who} video packetsLost`).toBe(0);
      expect(after[who].audio.packetsLost, `${who} audio packetsLost`).toBe(0);
    }
  });

  test('leaving is noticed by the other side', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice');
    const bob = await joinAs(browser, contexts, roomUrl, 'bob');
    await expect.poll(() => remoteOf(alice.page)).toBe('bob');
    await expect.poll(() => remoteOf(bob.page)).toBe('alice');

    await bob.page.click('#leave');

    await expect(alice.page.locator('#remote-name')).toHaveText('the other side left', { timeout: 10_000 });
    await expect.poll(() => remoteOf(alice.page)).toBeNull();
    await expect(bob.page.locator('#lobby')).toBeVisible();
    await expect.poll(() => bob.page.evaluate(() => window.call.joined)).toBe(false);
  });
});
