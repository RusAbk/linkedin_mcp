import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "../../src/app.js";
import { SALES_PEOPLE_SEARCH_URL } from "../../src/linkedin/selectors.js";

const app = createApp();
try {
  const inventory = await app.browser.runExclusiveOn("search", async (page) => {
    await page.goto(SALES_PEOPLE_SEARCH_URL, { waitUntil: "domcontentloaded" });
    await app.browser.assertAuthenticated(page);
    await page.locator("fieldset[data-x-search-filter]").first().waitFor({ state: "attached" });
    const all = page.getByRole("button", { name: /see all filters/i });
    if (await all.isVisible()) {
      await all.click();
      await page.waitForTimeout(300);
    }
    const filters = await page.locator("fieldset[data-x-search-filter]").evaluateAll((nodes) =>
      nodes.map((node) => ({ key: node.getAttribute("data-x-search-filter"), text: (node as HTMLElement).innerText })),
    );
    const diagnostics = await app.browser.saveDiagnostics(page, "filter-inventory");
    return { filters, diagnostics };
  });
  await fs.writeFile(path.join(app.config.diagnosticsDir, "filter-inventory.json"), JSON.stringify(inventory, null, 2));
  console.log(JSON.stringify(inventory, null, 2));
} finally {
  await app.close();
}
