import { test, expect } from "@playwright/test";

for (const width of [390, 1440]) {
  test(`landing and account dialog at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Measure the work/ })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".landing-siq-logo")).toHaveJSProperty("complete", true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const canvas = page.locator("canvas.shader-bg");
    expect(await canvas.evaluate(node => getComputedStyle(node).position)).toBe("fixed");

    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(page.getByText("Runtime by agent", { exact: true })).toBeVisible();
    await expect(page.locator(".landing-meter-list")).toContainText("Claude Code");
    expect(await canvas.evaluate(node => Math.round(node.getBoundingClientRect().top))).toBe(0);
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await expect(page.getByText("Active time by project", { exact: true })).toBeVisible();
    const board = page.getByRole("table", { name: "Example team leaderboard" });
    await expect(board).toContainText("Alex Morgan");
    await expect(board).toContainText("Jordan Lee");
    await expect(board).toContainText("Taylor Chen");
    await expect(page.locator(".landing-metrics")).toContainText("15h 00m");
    await expect(page.locator(".landing-metrics")).toContainText("32h 00m");
    await expect(page.locator(".landing-meter-list .is-plain")).toHaveCount(0);
    await expect(page.locator(".landing-meter-list img")).toHaveCount(3);
    await page.getByRole("button", { name: "Show Alex Morgan's work" }).click();
    await expect(page.locator(".landing-metrics")).toContainText("6h 00m");
    await expect(page.locator(".landing-metrics")).toContainText("14h 00m");
    await expect(page.locator(".landing-meter-list")).not.toContainText("Relay App");
    await page.getByRole("button", { name: "All members" }).click();
    await expect(page.locator(".landing-meter-list")).toContainText("Relay App");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("heading", { name: /Measure the work/ }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`landing-${width}.png`), fullPage: true });

    const createAccount = page.locator(".landing-actions").getByRole("button", { name: "Create account" });
    await createAccount.click();
    const dialog = page.getByRole("dialog", { name: "Create your account" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
    await expect(dialog.getByLabel(/Workspace name/)).toBeVisible();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    // Native modal focus never reaches the page behind it.
    for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
    expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`signup-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(createAccount).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");

    await page.locator(".landing-actions").getByRole("button", { name: "Log in" }).click();
    await expect(page.getByRole("dialog", { name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("Email", { exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Close sign-in window" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
}

test("reduced motion keeps a static landing background", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Measure the work/ })).toBeVisible();
  await expect(page.locator("canvas.shader-bg")).toHaveCount(0);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByText("Runtime by agent", { exact: true })).toBeVisible();
});
