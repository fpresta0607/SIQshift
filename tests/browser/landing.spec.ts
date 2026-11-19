import { test, expect, type Locator, type Page } from "@playwright/test";

import { openSignupDownload } from "./harness.js";

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

    // Both lists show at once, with no switch between them.
    const projects = page.getByRole("region", { name: "Projects" });
    const agents = page.getByRole("region", { name: "Agents" });
    await expect(agents).toContainText("Claude Code");
    await expect(projects).toContainText("Atlas Portal");
    await expect(page.getByRole("group", { name: "Projects or agents" })).toHaveCount(0);
    // The example is the app's one dashboard page: no tabs, and the four kept totals once each.
    await expect(page.getByRole("group", { name: "Humans or agents" })).toHaveCount(0);
    await expect(page.locator(".tv-total dt")).toHaveText(["Tokens", "Active time", "Agent time", "Recorded time"]);
    const board = page.getByRole("table", { name: "People" });
    await expect(board).toContainText("Alex Morgan");
    await expect(board).toContainText("Jordan Lee");
    await expect(board).toContainText("Taylor Chen");
    // Each person's tokens, in and out, in a column the board can rank by.
    await expect(board.getByRole("columnheader", { name: "Tokens" })).toBeVisible();
    await expect(board).toContainText(" in · ");
    await expect(page.getByRole("combobox", { name: /Rank by/ }).getByRole("option", { name: "By tokens" })).toHaveCount(1);
    await expect(page.locator(".tv-totals")).toContainText("15h 00m");
    await expect(page.locator(".tv-totals")).toContainText("32h 00m");
    // Every project wears a built-in icon, and so does each person's top project.
    await expect(projects.locator(".is-plain")).toHaveCount(0);
    await expect(projects.locator(".project-icon")).toHaveCount(3);
    await expect(board.locator(".tv-sub .project-icon")).toHaveCount(3);
    await page.getByRole("button", { name: "Show Alex Morgan's work" }).click();
    expect(await canvas.evaluate(node => Math.round(node.getBoundingClientRect().top))).toBe(0);
    await expect(page.locator(".tv-totals")).toContainText("6h 00m");
    await expect(page.locator(".tv-totals")).toContainText("14h 00m");
    await expect(projects).not.toContainText("Relay App");
    await page.getByRole("button", { name: "Everyone" }).click();
    await expect(projects).toContainText("Relay App");
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
  await expect(page.getByRole("region", { name: "Agents" })).toContainText("Claude Code");
});

// The home hero's download button sets the look and the hover the site's other
// primary buttons share: a lift of 2px and a stronger glow, on hover and on
// keyboard focus alike, with the lift dropped under reduced motion.
const LIFTED = "matrix(1, 0, 0, 1, 0, -2)";

const restingShadow = (button: Locator): Promise<string> => button.evaluate((node) => getComputedStyle(node).boxShadow);

async function expectHoverEffect(button: Locator, isLifted: boolean): Promise<void> {
  const resting = await restingShadow(button);
  await expect(button).toHaveCSS("transform", "none");
  await button.hover();
  await expect(button).toHaveCSS("transform", isLifted ? LIFTED : "none");
  await expect(button).not.toHaveCSS("box-shadow", resting);
  await expect(button).toHaveCSS("background-image", "none");
}

async function expectFocusEffect(button: Locator): Promise<void> {
  const resting = await restingShadow(button);
  await button.focus();
  await expect(button).toHaveCSS("transform", LIFTED);
  await expect(button).not.toHaveCSS("box-shadow", resting);
  await expect(button).toHaveCSS("background-image", "none");
  await button.blur();
  await expect(button).toHaveCSS("transform", "none");
}

const landingButtons = (page: Page): Locator[] => {
  const header = page.getByRole("navigation", { name: "SIQshift navigation" });
  return [
    page.locator("#install").getByRole("link", { name: "Download for Windows" }),
    header.getByRole("button", { name: "Sign in" }),
    header.getByRole("button", { name: "Sign up" }),
    page.locator(".landing-closing").getByRole("button", { name: "Create account" }),
  ];
};

test("the home page's primary buttons lift and glow on keyboard focus as on hover", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Measure the work/ })).toBeVisible();

  // Keyboard focus first: once the mouse has moved, Chromium stops drawing focus as visible.
  for (const button of landingButtons(page)) await expectFocusEffect(button);
  for (const button of landingButtons(page)) await expectHoverEffect(button, true);

  await page.getByRole("navigation", { name: "SIQshift navigation" }).getByRole("button", { name: "Sign up" }).click();
  const dialog = page.getByRole("dialog", { name: "Create your account" });
  await expectHoverEffect(dialog.getByRole("button", { name: "Create account" }), true);
});

test("under reduced motion the primary buttons glow on hover without moving", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Measure the work/ })).toBeVisible();

  for (const button of landingButtons(page)) {
    await expect(button).toHaveCSS("transition-duration", "0s");
    await expectHoverEffect(button, false);
  }

  await page.getByRole("navigation", { name: "SIQshift navigation" }).getByRole("button", { name: "Sign up" }).click();
  const submit = page.getByRole("dialog", { name: "Create your account" }).getByRole("button", { name: "Create account" });
  await expect(submit).toHaveCSS("transition-duration", "0s");
  await expectHoverEffect(submit, false);
});

test("the account dialog's submit keeps the hero's look while it is busy under the pointer", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "SIQshift navigation" }).getByRole("button", { name: "Sign up" }).click();
  const submit = page.getByRole("dialog", { name: "Create your account" }).getByRole("button", { name: "Create account" });
  const restingBorder = await submit.evaluate((node) => getComputedStyle(node).borderColor);

  await submit.evaluate((node) => node.setAttribute("disabled", ""));
  await submit.hover();

  await expect(submit).toHaveCSS("background-image", /linear-gradient/);
  await expect(submit).toHaveCSS("border-color", restingBorder);
  await expect(submit).toHaveCSS("transform", "none");
});

test("the download button after sign-up wears the hero's look and hover", async ({ page }) => {
  await openSignupDownload(page);
  const download = page.getByRole("link", { name: "Download for Windows" });
  await expect(download).toHaveCSS("text-transform", "none");
  await expect(download).toHaveCSS("background-image", /linear-gradient/);

  await expectFocusEffect(download);
  await expectHoverEffect(download, true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.mouse.move(0, 0);
  await expectHoverEffect(download, false);
});
