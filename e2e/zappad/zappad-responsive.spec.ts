import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const ROUTES = [
  {
    path: "/launch",
    heading: "Launch a token. Tokenize its fees.",
    currentNav: "Studio",
  },
  {
    path: "/launch/explore",
    heading: "Every launch. One source of truth.",
    currentNav: "Explore",
  },
  {
    path: "/launch/portfolio",
    heading: "Your launches. Your fee rights.",
    currentNav: "My fee rights",
  },
] as const;

for (const route of ROUTES) {
  test(`${route.path} stays responsive, semantic, and accessible`, async ({
    page,
  }) => {
    await page.goto(route.path);

    const main = page.locator("main#main");
    await expect(main).toHaveCount(1);
    await expect(main).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: route.heading }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "ZapPad" })
        .getByRole("link", { name: route.currentNav, exact: true }),
    ).toHaveAttribute("aria-current", "page");

    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "Skip to content" });
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toHaveAttribute("href", "#main");

    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - window.innerWidth,
      body: document.body.scrollWidth - window.innerWidth,
    }));
    expect(overflow.document).toBeLessThanOrEqual(1);
    expect(overflow.body).toBeLessThanOrEqual(1);

    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      accessibility.violations,
      accessibility.violations
        .map(
          (violation) =>
            `${violation.id}: ${violation.nodes
              .map((node) => node.target.join(" "))
              .join(", ")}`,
        )
        .join("\n"),
    ).toEqual([]);
  });
}
