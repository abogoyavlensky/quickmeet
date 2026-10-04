// The interface's language: Russian for a browser whose first language is
// Russian, English otherwise, unless the account pins one (Settings).
// Every other spec runs in English (playwright.config.js, locale).
import { test, expect } from '@playwright/test';
import { newRoom, openLobby, joinAs } from './helpers.js';

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
