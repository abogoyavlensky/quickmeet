import { test, expect } from '@playwright/test';
import { newRoom } from './helpers.js';

// newRoom signs up first: starting a meeting takes an account.
test('"New call" creates a room and opens it', async ({ page }) => {
  const roomUrl = await newRoom(page);
  expect(roomUrl).toMatch(/\/room\/[0-9a-f]{12}$/);
  await expect(page.locator('#lobby')).toBeVisible();
});
