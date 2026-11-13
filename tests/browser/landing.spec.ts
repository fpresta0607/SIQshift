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
    expect(await page.locator(".landing-scene").evaluate(node => getComputedStyle(node).position)).toBe("fixed");

    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(page.locator(".tv-list .tv-card-note")).toHaveText("Agent time");
    await expect(page.locator(".tv-meter-list")).toContainText("Claude Code");
    expect(await canvas.evaluate(node => Math.round(node.getBoundingClientRect().top))).toBe(0);
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await expect(page.locator(".tv-list .tv-card-note")).toHaveText("Recorded time");
    const board = page.getByRole("table", { name: "People" });
    await expect(board).toContainText("Alex Morgan");
    await expect(board).toContainText("Jordan Lee");
    await expect(board).toContainText("Taylor Chen");
    await expect(page.locator(".tv-totals")).toContainText("15h 00m");
    await expect(page.locator(".tv-totals")).toContainText("32h 00m");
    await expect(page.locator(".tv-meter-list .is-plain")).toHaveCount(0);
    await expect(page.locator(".tv-meter-list img")).toHaveCount(3);
    await page.getByRole("button", { name: "Show Alex Morgan's work" }).click();
    await expect(page.locator(".tv-totals")).toContainText("6h 00m");
    await expect(page.locator(".tv-totals")).toContainText("14h 00m");
    await expect(page.locator(".tv-meter-list")).not.toContainText("Relay App");
    await page.getByRole("button", { name: "All members" }).click();
    await expect(page.locator(".tv-meter-list")).toContainText("Relay App");
    // The footer that sat under the example is gone.
    await expect(page.getByText("Local agents, shared visibility")).toHaveCount(0);

    // The install selector flips panels in place: the hero keeps its height and
    // only the picked system's panel can be seen or reached.
    const install = page.locator("#install");
    const heroHeight = () => page.locator(".landing-hero").evaluate(node => node.getBoundingClientRect().height);
    await expect(install.getByRole("tab", { name: "Windows" })).toHaveAttribute("aria-selected", "true");
    await expect(install.getByRole("link", { name: "Download for Windows" })).toBeVisible();
    const heroHeightOnWindows = await heroHeight();
    await install.getByRole("tab", { name: "Mac" }).click();
    await expect(install.getByRole("link", { name: "Download for Windows" })).toBeHidden();
    await expect(install.getByRole("link", { name: "Download for Mac" })).toBeVisible();
    expect(await heroHeight()).toBe(heroHeightOnWindows);
    await install.getByRole("tab", { name: "Windows" }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("heading", { name: /Measure the work/ }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`landing-${width}.png`), fullPage: true });

    // Sign in and Sign up sit in the header at every width; the hero holds only the download.
    const header = page.getByRole("navigation", { name: "SIQshift navigation" });
    const signUp = header.getByRole("button", { name: "Sign up" });
    await signUp.click();
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
    await expect(signUp).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");

    await header.getByRole("button", { name: "Sign in" }).click();
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
  await expect(page.locator(".tv-list .tv-card-note")).toHaveText("Agent time");
});
