// Accounts: who may start a meeting, and that guests need none.
import { test, expect } from '@playwright/test';
import { signUp, openLobby } from './helpers.js';

test.describe('accounts', () => {
  test('signed out, the landing page offers to sign in and cannot start a meeting', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#signed-out')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign up' })).toBeVisible();
    await expect(page.locator('#new')).toBeHidden();
  });

  test('sign up, start a meeting with the name filled in, sign out', async ({ page }) => {
    const email = await signUp(page, 'alice');
    const local = email.split('@')[0];
    await expect(page.locator('#who')).toHaveText(local);

    await page.click('#new');
    await expect(page).toHaveURL(/\/room\/[0-9a-f]{12}$/);
    await expect(page.locator('#lobby')).toBeVisible();
    await expect(page.locator('#identity')).toHaveValue(local);

    await page.goto('/');
    await page.click('#signout');
    await expect(page.locator('#signed-out')).toBeVisible();
    await expect(page.locator('#new')).toBeHidden();
  });

  test('a wrong password is refused, a right one signs in', async ({ page }) => {
    const email = await signUp(page, 'bob');
    await page.click('#signout');
    await expect(page.locator('#signed-out')).toBeVisible();

    await page.goto('/signin');
    await page.fill('#email', email);
    await page.fill('#password', 'wrong password');
    await page.click('#submit');
    await expect(page.locator('#error')).toContainText('Invalid email or password');
    await expect(page).toHaveURL(/\/signin$/);

    await page.fill('#password', 'correct horse');
    await page.click('#submit');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('#signed-in')).toBeVisible();
  });

  test('signing up twice with one address is refused with a message', async ({ page }) => {
    const email = await signUp(page, 'dup');
    await page.goto('/signup');
    await page.fill('#email', email.toUpperCase());
    await page.fill('#password', 'another one');
    await page.click('#submit');
    await expect(page.locator('#error')).toContainText('already exists');
  });

  test('settings change the name the landing page and the lobby show', async ({ page }) => {
    await signUp(page, 'carol');
    await page.goto('/settings');
    await expect(page.locator('#email')).toContainText('carol-');
    await page.fill('#display-name', 'Carol C.');
    await page.click('#submit');
    await expect(page.locator('#status')).toBeVisible();

    await page.goto('/');
    await expect(page.locator('#who')).toHaveText('Carol C.');
    await page.click('#new');
    await expect(page.locator('#identity')).toHaveValue('Carol C.');
  });

  test('a guest opens the link with no account and an empty name', async ({ browser, page }) => {
    await signUp(page, 'host');
    await page.click('#new');
    await expect(page).toHaveURL(/\/room\/[0-9a-f]{12}$/);
    const contexts = [];
    try {
      const guest = await openLobby(browser, contexts, page.url(), '');
      await expect(guest.page.locator('#lobby')).toBeVisible();
      await expect(guest.page.locator('#identity')).toHaveValue('');
      // The guest's context has no session: the landing page is signed out.
      await guest.page.goto('/');
      await expect(guest.page.locator('#signed-out')).toBeVisible();
    } finally {
      await Promise.all(contexts.map(c => c.close()));
    }
  });
});
