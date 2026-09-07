import { test, expect, type Page } from "@playwright/test";

const NOW = Date.parse("2026-09-04T12:00:00Z");
const mkIssue = (body: object) => ({ contentType: "application/json", body: JSON.stringify(body) });

async function mock(page: Page): Promise<void> {
  await page.route("**/yt/api/issues/1?*", (route) =>
    route.fulfill(mkIssue({
      idReadable: "INFRA-1", summary: "Родительская задача: подготовить релиз",
      resolved: null,
      customFields: [{ name: "Size", value: { name: "L" } }, { name: "State", value: { name: "In Progress" } }],
      links: [{ direction: "OUTBOUND", linkType: { name: "Subtask", sourceToTarget: "parent for", targetToSource: "subtask of" }, issues: [{ idReadable: "INFRA-2" }, { idReadable: "INFRA-3" }] }],
    })));
  await page.route("**/yt/api/issues/INFRA-2?*", (route) =>
    route.fulfill(mkIssue({ idReadable: "INFRA-2", summary: "Обновить зависимости", resolved: null, customFields: [{ name: "Size", value: { name: "S" } }], links: [] })));
  await page.route("**/yt/api/issues/INFRA-3?*", (route) =>
    route.fulfill(mkIssue({ idReadable: "INFRA-3", summary: "Написать changelog", resolved: null, customFields: [], links: [] })));
  await page.route("**/yt/api/issues/**/activities?*", (route) =>
    route.fulfill(mkIssue([{ timestamp: "2026-09-04T10:00:00Z", field: { name: "State" }, added: [{ name: "In Progress" }], removed: [{ name: "Open" }] }])));
}

async function build(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("tab", { name: "Подключение" }).click();
  await page.fill("#token", "perm:test");
  await page.getByRole("tab", { name: "Задачи" }).click();
  await page.fill("#ids", "1");
  await page.getByRole("button", { name: "Загрузить задачи" }).click();
  await page.getByRole("button", { name: "Построить" }).click();
  await expect(page.locator("[data-tid='gantt-svg']").first()).toBeVisible({ timeout: 15000 });
}

test("новые фичи диаграммы", async ({ page }) => {
  await mock(page);
  await build(page);

  // 1. подсветка строки при наведении
  const row = page.locator(".gantt-table tbody tr").first();
  const bgBefore = await row.locator("td").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.locator("[data-tid='gantt-svg']").first().hover();
  const bgAfter = await row.locator("td").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bgAfter).not.toBe(bgBefore);

  // 2. вертикальный сдвиг уровней: текст ребёнка ниже родителя
  const ys = await page.evaluate(() => {
    const texts = [...document.querySelectorAll("[data-tid='gantt-labels'] text")]
      .map((t) => ({ s: (t.textContent || "").trim(), top: t.getBoundingClientRect().top }))
      .filter((t) => t.s.includes("INFRA-"));
    return { parent: texts[0].top, child: texts[1].top };
  });
  expect(ys.child).toBeGreaterThan(ys.parent);

  // 3. тултип с полным названием при наведении на название
  await page.locator("[data-tid='gantt-labels'] text").first().hover();
  await expect(page.locator(".MuiTooltip-tooltip")).toContainText("Родительская задача: подготовить релиз");

  // 4. ресайзер меняет ширину колонки и сохраняется в localStorage
  const labelW = () => page.evaluate(() =>
    (document.querySelector(".gantt-label-svg") as SVGSVGElement)!.width.baseVal.value);
  const w0 = await labelW();
  await page.evaluate(() => {
    const r = document.querySelector(".gantt-resizer") as HTMLElement;
    const box = r.getBoundingClientRect();
    const fire = (type: string, x: number) =>
      window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: box.top, bubbles: true }));
    r.dispatchEvent(new MouseEvent("mousedown", { clientX: box.left, clientY: box.top, bubbles: true }));
    fire("mousemove", box.left + 100);
    fire("mouseup", box.left + 100);
  });
  await page.waitForTimeout(200);
  const w1 = await labelW();
  expect(w1).toBeGreaterThan(w0 + 90);
  const saved = await page.evaluate(() => localStorage.getItem("yt_labelw"));
  expect(Number(saved)).toBe(Math.round(w1));
});
