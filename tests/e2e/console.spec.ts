import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function state(page: Page) {
  return (await page.request.get('/api/state')).json();
}

test('loads the console and connects the WebSocket', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('AMBIENT ACOUSTICS CONSOLE')).toBeVisible();
  await expect(page.getByText('Core OK')).toBeVisible();
  await expect(page.getByRole('button', { name: /Calm/ })).toBeVisible();
});

test('changing scene in the UI updates core state', async ({ page }) => {
  await page.goto('/');
  await page.locator('.scene-btn', { hasText: 'Combat' }).click();
  await expect.poll(async () => (await state(page)).scene.current).toBe('combat');
  await expect(page.locator('.scene-btn[aria-current="true"]')).toContainText('ACTIVE');
});

test('keyboard shortcuts switch scenes and cycle mode', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.scene-btn').first()).toBeVisible();
  await page.keyboard.press('1');
  await expect.poll(async () => (await state(page)).scene.current).toBe('calm');
  const before = (await state(page)).automation.mode;
  await page.keyboard.press('m');
  await expect.poll(async () => (await state(page)).automation.mode).not.toBe(before);
  await page.request.post('/api/mode', { data: { mode: 'suggest' } });
});

test('a suggestion can be accepted from the Scope', async ({ page }) => {
  await page.goto('/');
  await page.request.post('/api/mode', { data: { mode: 'suggest' } });
  await page.request.post('/api/scene', { data: { sceneId: 'calm' } });
  await page.request.post('/api/sim/say', {
    data: { playerId: 'ant', text: "It's an ambush! Weapons out, combat begins!" },
  });
  const accept = page.getByRole('button', { name: /Accept/ });
  await expect(accept).toBeVisible();
  await accept.click();
  await expect.poll(async () => (await state(page)).scene.current).toBe('combat');
});

test('the simulator fires a personal SFX and shows a callout in the log', async ({ page }) => {
  await page.goto('/#/simulator');
  await page.getByLabel('Speak as').selectOption('james');
  await page.getByLabel('Line to say').fill('I ignite my lightsaber');
  await page.getByRole('button', { name: 'Say' }).click();
  await expect(page.getByText(/saber-ignite · /).first()).toBeVisible();
});

test('reduced motion and CRT toggles apply', async ({ page }) => {
  await page.goto('/#/settings');
  const crt = page.getByLabel('CRT effect (vignette)');
  await crt.uncheck();
  await expect(page.locator('body')).not.toHaveClass(/crt/);
  await crt.check();
  await expect(page.locator('body')).toHaveClass(/crt/);
  await page.getByLabel(/Reduced motion on this device/).check();
  await expect(page.locator('body')).toHaveClass(/reduced-motion/);
});

for (const route of ['', '#/library', '#/triggers', '#/players', '#/scenes', '#/settings']) {
  test(`axe: no serious accessibility violations on ${route || 'console'}`, async ({ page }) => {
    await page.goto(`/${route}`);
    await expect(page.getByText('Core OK')).toBeVisible();
    await page.waitForTimeout(300);
    const results = await new AxeBuilder({ page })
      .disableRules(['color-contrast-enhanced'])
      .analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(
      serious.map(
        (v) =>
          `${v.id}: ${v.nodes
            .map((n) => n.target.join(' '))
            .slice(0, 3)
            .join(', ')}`,
      ),
    ).toEqual([]);
  });
}
