// Rooms first (M4): the landing page lists my rooms with who is in them,
// joining a room puts it on my list, and a finished call shows in history.
import { test, expect } from '@playwright/test';
import { signUp, newRoom, openLobby, joinAs, remoteOf, statsOf } from './helpers.js';

test.describe('my rooms', () => {
  const contexts = [];
  test.afterEach(async () => {
    await Promise.all(contexts.splice(0).map(c => c.close()));
  });

  test('the list shows my room, its presence, a rename and a delete', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const id = roomUrl.split('/').pop();
    await page.goto('/');
    const row = page.locator(`#rooms li[data-id="${id}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator('.room-name')).toHaveText('Room ' + id);
    await expect(row.locator('.presence')).toHaveText('');

    // Rename through the prompt.
    page.once('dialog', d => d.accept('Mom'));
    await row.getByRole('button', { name: 'Rename' }).click();
    await expect(row.locator('.room-name')).toHaveText('Mom');

    // A guest waiting in the room shows up within a refresh.
    await joinAs(browser, contexts, roomUrl, 'bob');
    await expect(row.locator('.presence')).toHaveText('1 waiting', { timeout: 10_000 });

    // Delete, after confirming: the list empties and the link is dead.
    page.once('dialog', d => d.accept());
    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(row).toHaveCount(0);
    await expect(page.locator('#no-rooms')).toBeVisible();
    await page.goto(roomUrl);
    await expect(page.locator('#gone')).toBeVisible();
  });

  test('joining someone else\'s room puts it on my list, without owner actions', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const id = roomUrl.split('/').pop();
    // A second signed-up person in their own context.
    const context = await browser.newContext();
    contexts.push(context);
    await context.grantPermissions(['camera', 'microphone']);
    const other = await context.newPage();
    await signUp(other, 'dana');
    await other.goto('/');
    await expect(other.locator('#no-rooms')).toBeVisible();
    await other.goto(roomUrl);
    await other.click('#join');
    await other.waitForFunction(() => window.call.joined === true, null, { timeout: 15_000 });
    await other.click('#leave');
    await other.goto('/');
    const row = other.locator(`#rooms li[data-id="${id}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: 'Copy link' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Rename' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  });

  test('a finished call shows in the host\'s history with the guest\'s name', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    // Signed out, history sends to sign in; the host sees an empty one.
    await page.goto('/history');
    await expect(page.locator('#empty')).toBeVisible();

    const host = await joinAs(browser, contexts, roomUrl, 'host');
    // The host's own context has the session; joinAs opened a fresh one.
    // So the call is host (a guest context) plus bob; the history we check
    // belongs to whoever is signed in: join as the account too.
    await page.goto(roomUrl);
    await page.click('#join');
    await page.waitForFunction(() => window.call.joined === true, null, { timeout: 15_000 });
    await expect.poll(() => remoteOf(page)).toBe('host');
    await expect.poll(async () => (await statsOf(page)).audio?.packetsReceived ?? 0).toBeGreaterThan(0);
    await host.page.click('#leave');
    await page.click('#leave');
    await expect(page.locator('#lobby')).toBeVisible();

    // The webhooks are asynchronous and the page fetches once on load, so
    // poll by reloading.
    await page.goto('/history');
    await expect.poll(async () => {
      await page.reload();
      return page.locator('#calls tbody tr').count();
    }, { timeout: 15_000 }).toBe(1);
    const cells = page.locator('#calls tbody tr td');
    await expect(cells.nth(0)).toHaveText('host');
    await expect(cells.nth(2)).toHaveText(/^\d+:\d\d$/);
  });
});
