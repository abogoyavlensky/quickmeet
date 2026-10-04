// The interface's language: Russian for a browser whose first language is
// Russian, English otherwise, unless the account pins one (Settings).
// Every other spec runs in English (playwright.config.js, locale).
import { test, expect } from '@playwright/test';
import { newRoom, openLobby, joinAs, signUp } from './helpers.js';

const RU = { locale: 'ru-RU' };

test.describe('the interface language', () => {
  let contexts;
  test.beforeEach(() => { contexts = []; });
  test.afterEach(async () => { await Promise.all(contexts.map(c => c.close())); });

  test('a Russian browser gets the lobby in Russian', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const { page: guest } = await openLobby(browser, contexts, roomUrl, 'гость', RU);

    await expect(guest.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(guest.locator('#join')).toHaveText('Присоединиться');
    await expect(guest.locator('#identity')).toHaveAttribute('placeholder', 'Ваше имя');
    await expect(guest.locator('#blur-preview')).toHaveAttribute('aria-label', 'Размыть фон');
    await expect(guest.locator('#mic-preview')).toHaveAttribute('aria-label', 'Выключить микрофон');
    await expect(guest.locator('#presence')).toHaveText('Пока никого нет.');
    await expect(guest.locator('.devices label').first()).toContainText('Камера');
    // The host, an English browser, still reads English.
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#join')).toHaveText('Join call');
  });

  test('a language that changes during a call keeps the other person\'s name', async ({ browser, page }) => {
    const roomUrl = await newRoom(page);
    const { page: alice } = await joinAs(browser, contexts, roomUrl, 'alice');
    await joinAs(browser, contexts, roomUrl, 'bob');
    await expect(alice.locator('#remote-name')).toHaveText('bob');
    // What a late /api/me with another language does (room.html, fillName).
    // Read at once: a later event that writes the name again must not
    // hide a redraw that lost it.
    const shown = await alice.evaluate(() => {
      if (rememberLanguage('ru')) redraw();
      return document.getElementById('remote-name').textContent;
    });
    expect(shown).toBe('bob');
    await expect(alice.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(alice.locator('#mic')).toHaveAttribute('aria-label', 'Выключить микрофон');
  });

  test('the account pins a language, on every browser it signs in on', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'en-US' });
    contexts.push(context);
    const page = await context.newPage();
    const email = await signUp(page, 'pin');

    // Pinned in Settings: the page switches without a reload.
    await page.goto('/settings');
    await expect(page.locator('#language')).toHaveValue('auto');
    await page.selectOption('#language', 'ru');
    await expect(page.locator('h1')).toHaveText('Настройки');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(page).toHaveTitle('Настройки · quickmeet');
    await page.reload();
    await expect(page.locator('h1')).toHaveText('Настройки');
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Новый звонок' })).toBeVisible();

    // Back to English without a reload: the marks kept their English keys.
    await page.goto('/settings');
    await page.selectOption('#language', 'en');
    await expect(page.locator('h1')).toHaveText('Settings');
    await expect(page).toHaveTitle('Settings · quickmeet');
    await expect(page.locator('#display-name')).toHaveValue(/^pin-/);
    // History, opened directly: English.
    const history = await context.newPage();
    await history.goto('/history');
    await expect(history.locator('h1')).toHaveText('History');

    // Russian again, then a fresh English browser signs in: no cache, the
    // account decides.
    await page.selectOption('#language', 'ru');
    await expect(page.locator('h1')).toHaveText('Настройки');
    const other = await browser.newContext({ locale: 'en-US' });
    contexts.push(other);
    const elsewhere = await other.newPage();
    await elsewhere.goto('/signin');
    await expect(elsewhere.locator('h1')).toHaveText('Sign in');
    await elsewhere.fill('#email', email);
    await elsewhere.fill('#password', 'correct horse');
    await elsewhere.click('#submit');
    await expect(elsewhere).toHaveURL(/\/$/);
    await expect(elsewhere.getByRole('button', { name: 'Новый звонок' })).toBeVisible();
  });

  test('a Russian browser can pin English', async ({ browser }) => {
    const context = await browser.newContext(RU);
    contexts.push(context);
    const page = await context.newPage();
    await signUp(page, 'en-pin');
    await page.goto('/settings');
    await expect(page.locator('h1')).toHaveText('Настройки');
    await page.selectOption('#language', 'en');
    await expect(page.locator('h1')).toHaveText('Settings');
    await page.reload();
    await expect(page.locator('h1')).toHaveText('Settings');
    // Signing out forgets the account's choice: the browser decides again.
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.locator('#signed-out h1')).toHaveText('Говорите с людьми без совещаний.');
  });

  test('a refused save puts the select back and says why', async ({ page }) => {
    await signUp(page, 'refused');
    await page.goto('/settings');
    await expect(page.locator('#language')).toHaveValue('auto');
    await page.route('**/api/me', route => (route.request().method() === 'POST'
      ? route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"The language must be auto, en or ru."}' })
      : route.continue()));
    await page.selectOption('#language', 'ru');
    await expect(page.locator('#language-error')).toHaveText('The language must be auto, en or ru.');
    await expect(page.locator('#language')).toHaveValue('auto');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('the landing page and sign-in in Russian', async ({ browser }) => {
    const context = await browser.newContext(RU);
    contexts.push(context);
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('#signed-out h1')).toHaveText('Говорите с людьми без совещаний.');
    await expect(page.getByRole('link', { name: 'Войти' })).toBeVisible();
    await page.goto('/signin');
    await expect(page.locator('h1')).toHaveText('Войти');
    await expect(page).toHaveTitle('Вход · quickmeet');
    // A server sentence shown on the page is translated too.
    await page.fill('#email', 'nobody@example.com');
    await page.fill('#password', 'correct horse');
    await page.click('#submit');
    await expect(page.locator('#error')).toHaveText('Неверный адрес или пароль.');
  });
});
