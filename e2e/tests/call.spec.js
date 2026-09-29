// A real call between two browsers through the SFU embedded in the binary.
import { test, expect } from '@playwright/test';
import { newRoom, joinAs, remoteOf, statsOf } from './helpers.js';

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
    // A leave is not a lost connection.
    await expect(bob.page.locator('#notice')).toBeHidden();
  });

  test('the status says who we are waiting for', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice');
    await expect(alice.page.locator('#status')).toBeVisible();
    await expect(alice.page.locator('#status')).toContainText('Waiting for the other person');

    const bob = await joinAs(browser, contexts, roomUrl, 'bob');
    await expect(alice.page.locator('#status')).toBeHidden();

    await bob.page.click('#leave');
    await expect(alice.page.locator('#status')).toBeVisible({ timeout: 10_000 });
    await expect(alice.page.locator('#status')).toContainText('Waiting');
  });

  // The client's reconnection is driven by its own events; network emulation
  // cannot drop the SFU's UDP media deterministically, so the events are
  // emitted on the room object and the page's reaction is what is tested.
  test('reconnecting is shown', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const alice = await joinAs(browser, contexts, roomUrl, 'alice');
    await joinAs(browser, contexts, roomUrl, 'bob');
    await expect.poll(() => remoteOf(alice.page)).toBe('bob');

    await alice.page.evaluate(() => call.room.emit(LivekitClient.RoomEvent.Reconnecting));
    await expect(alice.page.locator('#status')).toHaveText('Reconnecting…');
    await alice.page.evaluate(() => call.room.emit(LivekitClient.RoomEvent.Reconnected));
    await expect(alice.page.locator('#status')).toBeHidden();
  });

  test('a lost connection returns to the lobby with a notice', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    await joinAs(browser, contexts, roomUrl, 'alice');
    const bob = await joinAs(browser, contexts, roomUrl, 'bob');
    await expect.poll(() => remoteOf(bob.page)).toBe('alice');

    await bob.page.evaluate(() => call.room.emit(LivekitClient.RoomEvent.Disconnected, LivekitClient.DisconnectReason.SIGNAL_CLOSE));
    await expect(bob.page.locator('#lobby')).toBeVisible();
    await expect(bob.page.locator('#notice')).toContainText('Connection lost');
    await expect.poll(() => bob.page.evaluate(() => window.call.joined)).toBe(false);
  });
});
