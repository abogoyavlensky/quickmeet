// Shared steps for the browser specs. Each test creates its own room and its
// own participants, so tests do not depend on each other and retries or
// --repeat-each stay valid.
import { expect } from '@playwright/test';

// Open the landing page, click "New meeting", return the room URL.
export async function newRoom(page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New meeting' }).click();
  await expect(page).toHaveURL(/\/room\/[0-9a-f]{12}$/);
  // The URL changes when the navigation commits; the room page's elements
  // exist only once it has loaded.
  await page.waitForLoadState();
  return page.url();
}

// A person at the room page, in the lobby, not joined: its own browser
// context (own origin state, permissions and fake devices). Page errors and
// console errors are echoed into the test output. `contextOptions` go to
// browser.newContext: test.use() configures only the fixture page, not the
// contexts a helper creates, so a phone-sized participant passes its
// viewport here.
export async function openLobby(browser, contexts, roomUrl, name, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  contexts.push(context);
  await context.grantPermissions(['camera', 'microphone']);
  const page = await context.newPage();
  page.on('pageerror', e => console.log(`[${name}] pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') console.log(`[${name}] console.error: ${m.text()}`); });
  await page.goto(roomUrl);
  await page.fill('#identity', name);
  return { context, page };
}

// A participant joined to the room under `name`.
export async function joinAs(browser, contexts, roomUrl, name, contextOptions = {}) {
  const person = await openLobby(browser, contexts, roomUrl, name, contextOptions);
  await person.page.click('#join');
  await person.page.waitForFunction(() => window.call.joined === true, null, { timeout: 15_000 });
  return person;
}

export const remoteOf = page => page.evaluate(() => window.call.remote);
export const statsOf = page => page.evaluate(() => window.call.stats());
