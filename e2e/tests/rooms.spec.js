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
    // One room fits on one page: no pager.
    await expect(page.locator('#pager')).toBeHidden();

    // Rename through the prompt; the next prompt offers the new name.
    page.once('dialog', d => d.accept('Mom'));
    await row.getByRole('button', { name: 'Rename' }).click();
    await expect(row.locator('.room-name')).toHaveText('Mom');
    let offered;
    page.once('dialog', d => { offered = d.defaultValue(); d.accept('Mum'); });
    await row.getByRole('button', { name: 'Rename' }).click();
    await expect(row.locator('.room-name')).toHaveText('Mum');
    expect(offered).toBe('Mom');

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

  test('the list comes twenty at a time, and the page survives a reload', async ({ page }) => {
    // 21 rooms; the API call carries this context's session cookie. The
    // first made is the oldest, alone on page 2.
    await newRoom(page);
    const oldest = page.url().split('/').pop();
    // created_at counts whole seconds and ties go by the random id: the
    // others must come a second later for this one to be the oldest.
    await page.waitForTimeout(1100);
    for (let i = 0; i < 20; i++) expect((await page.request.post('/api/rooms')).status()).toBe(201);

    await page.goto('/');
    const rows = page.locator('#rooms li');
    await expect(rows).toHaveCount(20);
    await expect(page.locator('#pager')).toBeVisible();
    await expect(page.locator('#newer')).toBeDisabled();
    await expect(page.locator('#older')).toBeEnabled();

    await page.click('#older');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-id', oldest);
    await expect(page).toHaveURL(/\/\?page=2$/);
    await expect(page.locator('#older')).toBeDisabled();

    await page.reload();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-id', oldest);

    // Deleting the last room on the last page steps back to the one before,
    // which is now everything: no pager, no page in the address.
    page.once('dialog', d => d.accept());
    await rows.first().getByRole('button', { name: 'Delete' }).click();
    await expect(rows).toHaveCount(20);
    await expect(page.locator('#pager')).toBeHidden();
    await expect(page).toHaveURL(/\/$/);

    // Newer goes back from a later page.
    expect((await page.request.post('/api/rooms')).status()).toBe(201);
    await page.goto('/?page=2');
    await expect(rows).toHaveCount(1);
    await page.click('#newer');
    await expect(rows).toHaveCount(20);
    await expect(page).toHaveURL(/\/$/);
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
    // poll by reloading until the call is there and finished (the leaves
    // may land after the join did).
    await page.goto('/history');
    await expect.poll(async () => {
      await page.reload();
      return page.locator('#calls tbody tr td').allTextContents();
    }, { timeout: 15_000 }).toEqual(['host', expect.any(String), expect.stringMatching(/^\d+:\d\d$/)]);
  });
});
