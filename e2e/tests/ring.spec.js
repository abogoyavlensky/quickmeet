// Ringing over Web Push. The headless shell has no push service, so a real
// subscription cannot be made here: turning ringing on, and a notification
// arriving, are checked on devices. What is checked here is everything
// around them: the offer on the list page, which subscription a page will
// adopt, and the Ring button on the call page (against a stored
// subscription whose sends fail harmlessly in the shim).
import { test, expect } from '@playwright/test';
import { signUp, newRoom, joinAs } from './helpers.js';

// A browser that has not been asked about notifications yet. The headless
// shell reports Notification.permission as "denied" whatever the context
// grants (the Permissions API does show the grant), so the page is told
// "default", as a fresh desktop browser would say.
async function notAskedYet(context) {
  await context.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'default' });
  });
}

// A browser that already holds a push subscription, as far as the page can
// tell: getRegistration answers a fake registration whose subscription
// records whether it was unsubscribed. `owner` is who turned ringing on,
// as push.on would have stored it.
async function fakeSubscription(context, owner) {
  await context.addInitScript(owner => {
    if (owner) localStorage.setItem('quickmeet.push.user', owner);
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/fake-device',
      options: { applicationServerKey: null },
      toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'BPdh', auth: 'au' } }; },
      unsubscribe() { window.unsubscribed = true; return Promise.resolve(true); },
    };
    const registration = { pushManager: { getSubscription: () => Promise.resolve(subscription) } };
    ServiceWorkerContainer.prototype.getRegistration = () => Promise.resolve(registration);
  }, owner);
}

test.describe('the offer to be rung', () => {
  const contexts = [];
  test.afterEach(async () => {
    await Promise.all(contexts.splice(0).map(c => c.close()));
  });

  test('shows where the browser may notify, and Not now is for good', async ({ browser }) => {
    const context = await browser.newContext();
    contexts.push(context);
    await notAskedYet(context);
    const page = await context.newPage();
    await signUp(page);
    const offer = page.locator('#ring-offer');
    await expect(offer).toBeVisible();
    await expect(offer).toContainText('Let people ring you on this device.');
    await expect(page.locator('#ring-on')).toBeVisible();
    await page.click('#ring-later');
    await expect(offer).toBeHidden();
    await page.reload();
    await expect(page.locator('#rooms, #no-rooms').first()).toBeAttached();
    await expect(page.locator('#who')).not.toBeEmpty();
    await expect(offer).toBeHidden();
  });

  test('is not shown where notifications are refused', async ({ browser }) => {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    await signUp(page);
    await expect(page.locator('#who')).not.toBeEmpty();
    expect(await page.evaluate(() => Notification.permission)).toBe('denied');
    await expect(page.locator('#ring-offer')).toBeHidden();
  });

  test('Settings offers the same switch', async ({ browser }) => {
    const context = await browser.newContext();
    contexts.push(context);
    await notAskedYet(context);
    const page = await context.newPage();
    await signUp(page);
    await page.goto('/settings');
    await expect(page.locator('#ring-toggle')).toHaveText('Let people ring me on this device');
  });
});

test.describe('a subscription already in the browser', () => {
  const contexts = [];
  test.afterEach(async () => {
    await Promise.all(contexts.splice(0).map(c => c.close()));
  });

  // Who posts the browser's subscription to the server.
  const posted = page => {
    const seen = [];
    page.on('request', r => { if (r.url().endsWith('/api/push/subscriptions')) seen.push(r.method()); });
    return seen;
  };

  test('is handed to the server again for the person who made it', async ({ browser }) => {
    const context = await browser.newContext();
    contexts.push(context);
    await notAskedYet(context);
    const page = await context.newPage();
    const email = await signUp(page);
    await fakeSubscription(context, email);
    const seen = posted(page);
    await page.goto('/');
    await expect.poll(() => seen.length).toBe(1);
    expect(await page.evaluate(() => window.unsubscribed)).toBeUndefined();
    // Subscribed already: no offer. Settings offers to stop.
    await expect(page.locator('#ring-offer')).toBeHidden();
    await page.goto('/settings');
    await expect(page.locator('#ring-toggle')).toHaveText('Stop ringing this device');
  });

  test("is dropped, not adopted, when it is someone else's", async ({ browser }) => {
    const context = await browser.newContext();
    contexts.push(context);
    await notAskedYet(context);
    const page = await context.newPage();
    await signUp(page);
    await fakeSubscription(context, 'whoever-signed-out@example.com');
    const seen = posted(page);
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => window.unsubscribed)).toBe(true);
    expect(seen).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('quickmeet.push.user'))).toBeNull();
  });
});

test.describe('the Ring button', () => {
  const contexts = [];
  test.afterEach(async () => {
    await Promise.all(contexts.splice(0).map(c => c.close()));
  });

  // The person at `page` joins the call they are in the lobby of.
  async function join(page) {
    await page.click('#join');
    await page.waitForFunction(() => window.call.joined === true, null, { timeout: 15_000 });
  }

  test('rings the other member while alone, then rests', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const id = roomUrl.split('/').pop();

    // Bob signs up, joins the room once (which makes him a member) and has
    // a device. Its key is not a point on the curve, so the server's send
    // fails before any network: nothing leaves the machine.
    const bobContext = await browser.newContext();
    contexts.push(bobContext);
    const bob = await bobContext.newPage();
    const bobEmail = await signUp(bob, 'bob');
    expect((await bob.request.post(`/api/rooms/${id}/token`, { data: {} })).ok()).toBe(true);
    expect((await bob.request.post('/api/push/subscriptions', {
      data: { endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-' + Date.now(), keys: { p256dh: 'AAAA', auth: 'AAAA' } },
    })).ok()).toBe(true);

    await join(page);
    const ring = page.locator('#ring');
    await expect(ring).toBeVisible();
    await expect(ring).toHaveText('Ring ' + bobEmail.split('@')[0]);
    await expect(ring).toBeEnabled();

    const rung = page.waitForResponse(r => r.url().endsWith(`/api/rooms/${id}/ring`));
    await ring.click();
    expect((await rung).status()).toBe(200);
    await expect(ring).toHaveText('Rung');
    await expect(ring).toBeDisabled();

    // Someone arrives: the waiting state, and the button with it, is gone.
    await joinAs(browser, contexts, roomUrl, 'guest');
    await expect(ring).toBeHidden({ timeout: 15_000 });
  });

  test('is absent when nobody could be rung', async ({ page }) => {
    await newRoom(page);
    await join(page);
    await expect(page.locator('#status')).toHaveText('Waiting for the other person.');
    expect(await page.evaluate(() => window.call.ring)).toEqual([]);
    await expect(page.locator('#ring')).toBeHidden();
    await expect(page.locator('#invite')).toBeVisible();
  });
});
