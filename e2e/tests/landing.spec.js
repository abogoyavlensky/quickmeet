import { test, expect } from '@playwright/test';

test('"New meeting" creates a room and opens it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New meeting' }).click();
  await expect(page).toHaveURL(/\/room\/[0-9a-f]{12}$/);
  const id = new URL(page.url()).pathname.split('/').pop();
  await expect(page.locator('#room-id')).toHaveText(id);
});
