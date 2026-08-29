import { expect, test } from "@playwright/test";

import { openAgentsGroup, openClockCard, openMemberStats, openTodayCard } from "./harness.js";

/** Every `.meter-row`'s box, plus the boxes of the four cells inside it. */
const rowBoxes = (page: import("@playwright/test").Page) =>
  page.locator(".meter-row").evaluateAll((rows) =>
    rows.map((row) => {
      const box = (selector: string): { left: number; right: number; width: number; height: number } => {
        const rect = row.querySelector(selector)!.getBoundingClientRect();
        return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), height: Math.round(rect.height) };
      };
      const bar = row.querySelector(".meter-bar");
      return {
        left: Math.round(row.getBoundingClientRect().left),
        name: row.querySelector(".meter-name")!.textContent ?? "",
        mark: box(".app-mark, .project-dot"),
        nameCell: box(".meter-name"),
        // An agent's row spends the third cell on its plan dial instead, so
        // "the bar" is whichever of the two the row is carrying.
        share: box(".meter-bar, .quota"),
        // The bar's fill is the ::before, so this is what "proportional"
        // actually renders as - the bar element itself is always full width.
        fill: bar === null ? null : Number.parseFloat(getComputedStyle(bar, "::before").width),
        duration: box(".meter-duration"),
      };
    }));

// Both apps lay the Today card out in the same `.screen` column, so the same
// three claims are made about each of them.
for (const app of ["desktop", "web"] as const) {
  test.describe(`Today's session rows in ${app}`, () => {
    test("stay one column in the window the app opens at", async ({ page }) => {
      await page.setViewportSize({ width: 520, height: 920 });
      await openTodayCard(page, app);

      const rows = await rowBoxes(page);
      expect(rows).toHaveLength(6);
      expect(new Set(rows.map((row) => row.left)).size).toBe(1);
    });

    test("go two-up once the window has room, and read down the first column", async ({ page }) => {
      await page.setViewportSize({ width: 1000, height: 920 });
      await openTodayCard(page, app);

      const lefts = (await rowBoxes(page)).map((row) => row.left);
      expect(new Set(lefts).size).toBe(2);
      // Down-then-across: the heaviest-first sort still reads top to bottom, so
      // the first half of the rows is the whole of the left column.
      expect(new Set(lefts.slice(0, 3)).size).toBe(1);
      expect(new Set(lefts.slice(3)).size).toBe(1);
      expect(Math.min(...lefts.slice(0, 3))).toBeLessThan(Math.min(...lefts.slice(3)));
    });

    test("keep the bar drawable and the duration on one line in both columns", async ({ page }) => {
      await page.setViewportSize({ width: 1000, height: 920 });
      await openTodayCard(page, app);

      const rows = await rowBoxes(page);
      // What one line of the duration's own type actually measures, rather than
      // whichever row happened to come out shortest: a wrapped duration is
      // taller than this, and every row being equally wrong would still fail.
      const oneLine = await page.locator(".meter-duration").first().evaluate((cell) => {
        const style = getComputedStyle(cell);
        const height = style.lineHeight === "normal"
          ? Number.parseFloat(style.fontSize) * 1.2
          : Number.parseFloat(style.lineHeight);
        return Math.ceil(height);
      });
      for (const row of rows) {
        // 48px is the narrowest this design draws a share in; below it the fill
        // of a small row is a dot rather than a measure, and the quota dial's
        // plan name has nowhere to sit.
        expect(row.share.width, row.name).toBeGreaterThanOrEqual(48);
        expect(row.duration.height, row.name).toBeLessThanOrEqual(oneLine);
        expect(row.nameCell.right, row.name).toBeLessThanOrEqual(row.share.left);
        // Neither a bar nor a dial may spill into the duration's column.
        expect(row.share.right, row.name).toBeLessThanOrEqual(row.duration.left);
      }
      // The desktop spends one row's third cell on a plan dial, so the dial
      // really was exercised there; the web has no plan reading to draw and
      // every row carries a bar.
      expect(rows.filter((row) => row.fill === null)).toHaveLength(app === "desktop" ? 1 : 0);

      // One scan line down each column: every row in a column starts its bar and
      // ends its duration at the same x. Every .meter-row is its own grid, so
      // this only holds while the name track computes to the same length in all
      // of them - an `fr` there divides free space the `auto` duration column
      // has already made row-specific, and the bars stop lining up.
      const columns = [...new Set(rows.map((row) => row.left))].sort((a, b) => a - b);
      for (const column of columns) {
        const inColumn = rows.filter((row) => row.left === column);
        expect(new Set(inColumn.map((row) => row.share.left)).size, `column ${column} bar starts`).toBe(1);
        expect(new Set(inColumn.map((row) => row.duration.right)).size, `column ${column} duration ends`).toBe(1);
      }

      // A second column may cost the name room - `.meter-name` carries an
      // ellipsis by design and a 335px column is not going to fit every app's
      // full name - but it may never cost a measure: the duration, and the
      // dial's plan and reset window, all have to stay readable.
      const clipped = await page.locator(".meter-row").evaluateAll((meterRows) =>
        meterRows.flatMap((row) => [...row.querySelectorAll<HTMLElement>(".meter-duration, .quota-plan, .quota-window")]
          .filter((cell) => {
            // A cell with `text-overflow: ellipsis` reports the clipped width as
            // its scrollWidth, so the natural width comes off a loose clone.
            const probe = cell.cloneNode(true) as HTMLElement;
            probe.style.cssText = "position:absolute;visibility:hidden;width:auto;white-space:nowrap;overflow:visible";
            cell.parentElement?.appendChild(probe);
            const natural = probe.getBoundingClientRect().width;
            probe.remove();
            return natural > cell.clientWidth + 0.5;
          })
          .map((cell) => `${row.querySelector(".meter-name")?.textContent ?? ""}: ${cell.className}`)));
      // A truncated name is allowed; a truncated measure is not.
      expect(clipped).toEqual([]);
    });

    // The card's own comment calls the day's total "the page's largest
    // element", and for as long as its size hung off a panel the app had
    // retired it rendered at body size instead. Only a real browser resolves
    // which selectors actually matched.
    test("draws the day's total as the largest thing on the clock card", async ({ page }) => {
      await page.setViewportSize({ width: 520, height: 920 });
      await openClockCard(page, app);

      const sizes = await page.evaluate(() => ({
        elapsed: Number.parseFloat(getComputedStyle(document.querySelector(".elapsed")!).fontSize),
        label: Number.parseFloat(getComputedStyle(document.querySelector(".hero-title")!).fontSize),
        body: Number.parseFloat(getComputedStyle(document.body).fontSize),
      }));
      expect(sizes.elapsed).toBeGreaterThan(sizes.label * 3);
      expect(sizes.elapsed).toBeGreaterThan(sizes.body * 3);
    });
  });
}

test("a wide window spends its room on the name, not only on the bar", async ({ page }) => {
  // A fixed 10rem name cap ellipsized repo labels on a maximised dashboard
  // while the bar beside them ran past 1,000px. The name shares the row's
  // spare width with the bar instead, so it grows when the window does.
  await page.setViewportSize({ width: 900, height: 700 });
  await openAgentsGroup(page, "web");
  const narrow = (await rowBoxes(page))[0]!.nameCell.width;

  await page.setViewportSize({ width: 1800, height: 700 });
  await openAgentsGroup(page, "web");
  const wide = (await rowBoxes(page))[0]!.nameCell.width;

  expect(wide).toBeGreaterThan(narrow);
});

for (const app of ["desktop", "web"] as const) {
  test.describe(`the Agents tab in ${app}`, () => {
    test("gives each codebase a Today row: mark, name, proportional bar, duration", async ({ page }) => {
      await page.setViewportSize({ width: 900, height: 700 });
      await openAgentsGroup(page, app);

      const heads = await rowBoxes(page);
      expect(heads).toHaveLength(2);

      // One scan line: four cells, in order, on the same columns in every row.
      for (const head of heads) {
        expect(head.mark.right).toBeLessThanOrEqual(head.nameCell.left);
        expect(head.nameCell.right).toBeLessThanOrEqual(head.share.left);
        expect(head.share.right).toBeLessThanOrEqual(head.duration.left);
      }
      expect(new Set(heads.map((head) => head.share.left)).size).toBe(1);
      expect(new Set(heads.map((head) => head.duration.right)).size).toBe(1);

      // The bar is a share of the recorded agent time, not decoration: 75% and
      // 25% of the same track.
      expect(heads.map((head) => Math.round(((head.fill ?? 0) / head.share.width) * 100))).toEqual([75, 25]);

      // The held tag rides in the name's `·` subtitle, and only the group that
      // has a decided commit carries one.
      expect(heads.map((head) => head.name.includes("· 50% held"))).toEqual([true, false]);
    });

    // A phone is where this row runs out of room first, and an open drawer is
    // the only way to see one. The tab used to live in the dashboard's own
    // column and now lives in the All-stats overlay, which is narrower: the
    // `.shift-list` grid track floored at the row's min-content - its runtime,
    // owner, model and commit count laid end to end - and pushed every row
    // past the overlay's right edge, taking the duration off screen. jsdom
    // cannot see it: there is no layout engine to overflow.
    test("keeps an open drawer's shift durations on screen at phone width", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openAgentsGroup(page, app);
      // Set `open` rather than clicking each summary: the fixture ships one
      // drawer already open, so a blanket click would close it again.
      await page.locator(".shift-group").evaluateAll((groups) => {
        for (const group of groups) (group as HTMLDetailsElement).open = true;
      });

      const measured = await page.evaluate(() => {
        const modal = document.querySelector<HTMLElement>(".modal")!;
        return {
          viewport: document.documentElement.clientWidth,
          modalClientWidth: modal.clientWidth,
          modalScrollWidth: modal.scrollWidth,
          durationRights: [...document.querySelectorAll<HTMLElement>(".shift-row .shift-duration")]
            .map((cell) => Math.round(cell.getBoundingClientRect().right)),
          factsClipped: [...document.querySelectorAll<HTMLElement>(".shift-row .shift-facts")]
            .every((cell) => getComputedStyle(cell).textOverflow === "ellipsis"),
        };
      });

      // Every drawer really is open, so the rows below are the ones measured.
      expect(await page.locator(".shift-group[open]").count()).toBe(2);
      // The overlay scrolls vertically by design and horizontally never: a
      // scrollWidth past its client width is the row overflowing it.
      expect(measured.modalScrollWidth).toBe(measured.modalClientWidth);
      // The measure is what may not be lost. The facts beside it are allowed
      // to ellipsize, which is how the row gives way instead.
      expect(measured.durationRights.length).toBeGreaterThan(0);
      for (const right of measured.durationRights) {
        expect(right).toBeLessThanOrEqual(measured.viewport);
      }
      expect(measured.factsClipped).toBe(true);
    });

    // The whole point of the drawer: a busy range runs to hundreds of shift
    // rows, and a closed group must actually hide its own. jsdom cannot check
    // this - it has no rule hiding a closed `details` - so this is the only
    // place in the repo where the claim is testable at all.
    test("keeps a closed codebase's shifts hidden and an open one's readable", async ({ page }) => {
      await page.setViewportSize({ width: 900, height: 700 });
      await openAgentsGroup(page, app);

      await expect(page.locator(".shift-group:not([open]) .shift-row")).toBeHidden();
      await expect(page.locator(".shift-group[open] .shift-row")).toBeVisible();

      // Both heads stay measured whatever the drawer is doing, so the scan
      // line the test above pins is not a property of being open.
      expect(await rowBoxes(page)).toHaveLength(2);
    });
  });
}

for (const app of ["desktop", "web"] as const) {
  test.describe(`the All-stats card in ${app}`, () => {
    // The card's own arithmetic, drawn: the recorded total, the sentence
    // saying what the rest of it was, and two lists that both close on it.
    // The sentence replaced a four-word hint, so it is the first line on
    // either card long enough to need somewhere to wrap - and it wraps inside
    // the overlay, which is narrower than the page it used to be measured in.
    test("wraps the recorded sentence inside the overlay at phone width", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openMemberStats(page, app);

      const measured = await page.evaluate(() => {
        const modal = document.querySelector<HTMLElement>(".modal")!;
        const total = document.querySelector<HTMLElement>(".member-total, .today-total")!;
        return {
          viewport: document.documentElement.clientWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          modalClientWidth: modal.clientWidth,
          modalScrollWidth: modal.scrollWidth,
          totalRight: Math.round(total.getBoundingClientRect().right),
          // A one-line sentence at this width would mean it did not wrap,
          // which at 390px means it went somewhere off screen instead.
          totalLines: Math.round(total.getBoundingClientRect().height
            / Number.parseFloat(getComputedStyle(total).lineHeight)),
          durationRights: [...document.querySelectorAll<HTMLElement>(".app-row .app-duration")]
            .map((cell) => Math.round(cell.getBoundingClientRect().right)),
        };
      });

      expect(measured.documentScrollWidth).toBeLessThanOrEqual(measured.viewport);
      expect(measured.modalScrollWidth).toBe(measured.modalClientWidth);
      expect(measured.totalRight).toBeLessThanOrEqual(measured.viewport);
      expect(measured.totalLines).toBeGreaterThan(1);
      // Quiet time is a row like any other, so its duration stays on screen
      // with the rest of them.
      expect(measured.durationRights).toHaveLength(5);
      for (const right of measured.durationRights) {
        expect(right).toBeLessThanOrEqual(measured.viewport);
      }
    });

    test("keeps both lists' durations on one scan line at desktop width", async ({ page }) => {
      await page.setViewportSize({ width: 1000, height: 900 });
      await openMemberStats(page, app);

      const rights = await page.locator(".app-row .app-duration")
        .evaluateAll((cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().right)));
      // The project list and the app list are read against one another, so
      // their durations end on the same x - a project total and an app total
      // that do not line up read as two different measurements.
      expect(new Set(rights).size).toBe(1);
    });
  });
}
