// Скриншотные тесты: рендер приложения с замоканным YouTrack API.
// Мок делается через page.route ДО загрузки страницы — бэкенд не нужен.
import { test, expect, type Page } from "@playwright/test";

// детерминированная «текущая дата»: 2026-09-04 (пятница)
const NOW = Date.parse("2026-09-04T12:00:00Z");

const mkIssue = (body: object) => ({
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function mockYouTrack(page: Page, opts?: { resolved?: boolean; withHistory?: boolean }): Promise<void> {
  const resolved = opts?.resolved ?? false;
  const withHistory = opts?.withHistory ?? true;

  // корень вводится как «1» → запрос на /issues/1, ответ с idReadable INFRA-1
  await page.route("**/yt/api/issues/1?*", (route) =>
    route.fulfill(mkIssue({
      idReadable: "INFRA-1",
      summary: "Родительская задача: подготовить релиз",
      resolved: resolved ? "2026-09-10T00:00:00.000Z" : null,
      customFields: [
        { name: "Size", value: { name: "L" } },
        { name: "State", value: { name: "In Progress" } },
      ],
      links: [{
        direction: "OUTBOUND",
        linkType: { name: "Subtask", sourceToTarget: "parent for", targetToSource: "subtask of" },
        issues: [{ idReadable: "INFRA-2" }, { idReadable: "INFRA-3" }],
      }],
    })));

  await page.route("**/yt/api/issues/INFRA-2?*", (route) =>
    route.fulfill(mkIssue({
      idReadable: "INFRA-2",
      summary: "Обновить зависимости",
      resolved: resolved ? "2026-09-08T00:00:00.000Z" : null,
      customFields: [{ name: "Size", value: { name: "S" } }],
      links: [],
    })));

  await page.route("**/yt/api/issues/INFRA-3?*", (route) =>
    route.fulfill(mkIssue({
      idReadable: "INFRA-3",
      summary: "Написать changelog (без Size — считается M)",
      resolved: null,
      customFields: [],
      links: [],
    })));

  if (withHistory) {
    // История пользовательских полей через документированный activities endpoint.
    await page.route("**/yt/api/issues/**/activities?*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify([
          { timestamp: "2026-09-04T09:00:00Z", field: { name: "State" }, added: [{ name: "Open" }], removed: [] },
          { timestamp: "2026-09-04T10:00:00Z", field: { name: "State" }, added: [{ name: "In Progress" }], removed: [{ name: "Open" }] },
        ]),
      }));
  }
}

// MUI Tab имеет role="tab"
const tab = (page: Page, name: string) => page.getByRole("tab", { name });

async function build(page: Page): Promise<void> {
  await page.goto("/");
  // токен — на втором табе «Подключение»
  await tab(page, "Подключение").click();
  await page.fill("#token", "perm:test");
  // по умолчанию открыт таб «Задачи»
  await tab(page, "Задачи").click();
  await page.fill("#ids", "1");
  // шаг 1: загрузка тикетов, шаг 2: построение по выбранным полям
  await page.getByRole("button", { name: "Загрузить задачи" }).click();
  const buildBtn = page.getByRole("button", { name: "Построить" });
  await expect(buildBtn).toBeEnabled({ timeout: 15000 });
  await buildBtn.click();
  await expect(page.locator("[data-tid='gantt-svg']").first()).toBeVisible({ timeout: 15000 });
}

test.beforeEach(async ({ context, page }) => {
  // фиксируем ВЕСЬ clock, а не только Date.now: приложение читает дату через
  // new Date(), иначе после полуночи «сегодня» на диаграмме уезжает и снапшоты
  // перестают сходиться (page.clock.setFixedTime подменяет и Date, но не таймеры)
  await context.addInitScript(`Date.now = () => ${NOW};`);
  await page.clock.setFixedTime(new Date(NOW));
});

test("смена поля статуса пересчитывает факт без повторной загрузки истории", async ({ page }) => {
  await mockYouTrack(page);
  await page.route("**/yt/api/issues/1?*", (route) => route.fulfill(mkIssue({
    idReadable: "INFRA-1", summary: "Field selection", resolved: null, links: [],
    customFields: [
      { name: "Size", value: { name: "M" } },
      { name: "State", value: { name: "In Progress" } },
      { name: "Workflow", value: { name: "In Progress" } },
    ],
  })));
  let historyRequests = 0;
  await page.route("**/yt/api/issues/**/activities?*", async (route) => {
    historyRequests++;
    const params = new URL(route.request().url()).searchParams;
    expect(params.get("categories")).toBe("CustomFieldCategory");
    expect(params.get("fields")).toContain("customField(name)");
    await route.fulfill(mkIssue([
      { timestamp: Date.parse("2026-09-04T10:00:00Z"), field: { customField: { name: "State" } }, added: { name: "In Progress" } },
      { timestamp: Date.parse("2026-09-01T10:00:00Z"), field: { customField: { name: "Workflow" } }, added: [{ name: "In Progress" }] },
    ]));
  });
  await build(page);
  const fact = page.locator("[data-tid='gantt-svg'] text").filter({ hasText: /к\.д\./ });
  await expect(fact).toHaveText("1 к.д. / 1 р.д.");
  await page.locator("#stateField").click();
  await page.getByRole("option", { name: "Workflow" }).click();
  await page.getByRole("button", { name: "Построить" }).click();
  await expect(fact).toHaveText("4 к.д. / 4 р.д.");
  expect(historyRequests).toBe(1);
});

test("форма: пустое состояние", async ({ page }) => {
  await page.goto("/");
  // по умолчанию открыт таб «Задачи»
  await expect(page.locator("#ids")).toBeVisible();
  await expect(page.locator("#token")).not.toBeVisible();
  await expect(page).toHaveScreenshot("form-empty.png", { fullPage: true });
});

test("валидация: пустые обязательные поля подсвечены", async ({ page }) => {
  await page.goto("/");
  // URL и токен — на табе «Подключение»
  await tab(page, "Подключение").click();
  await page.fill("#baseUrl", "");
  // поля и «Построить» неактивны до загрузки — валидация срабатывает на «Загрузить задачи»
  await tab(page, "Задачи").click();
  await expect(page.getByRole("button", { name: "Построить" })).toBeDisabled();
  await page.getByRole("button", { name: "Загрузить задачи" }).click();
  await expect(page.locator("text=Укажите URL YouTrack").first()).toBeVisible();
  await expect(page).toHaveScreenshot("form-validation.png", { fullPage: true });
});

test("диаграмма: дерево 1 родитель + 2 ребёнка, план", async ({ page }) => {
  await mockYouTrack(page);
  await build(page);
  // id задач — в sticky-колонке слева (каждая строка — своя ячейка)
  const labels = page.locator("[data-tid='gantt-labels'] text");
  await expect(labels.filter({ hasText: "INFRA-1" })).toHaveCount(1);
  await expect(labels.filter({ hasText: "INFRA-2" })).toHaveCount(1);
  await expect(labels.filter({ hasText: "INFRA-3" })).toHaveCount(1);
  await expect(page).toHaveScreenshot("gantt-tree.png", { fullPage: true });
});

test("диаграмма: resolved-задача зачёркнута — приглушённый бар", async ({ page }) => {
  await mockYouTrack(page, { resolved: true });
  await build(page);
  // у resolved-бара приглушённая заливка #9aa5ba
  await expect(page.locator("[data-tid='gantt-svg'] rect[fill='#9aa5ba']").first()).toBeVisible();
  await expect(page).toHaveScreenshot("gantt-resolved.png", { fullPage: true });
});

test("диаграмма: сворачивание родителя скрывает поддерево", async ({ page }) => {
  await mockYouTrack(page);
  await build(page);
  // в Table каждая строка задачи — свой SVG-бар: считаем строки
  const rows = page.locator("[data-tid='gantt-svg']");
  const before = await rows.count();
  // стрелки сворачивания — в sticky-колонке задач
  await page.locator("[data-tid='gantt-labels'] text", { hasText: "▾" }).first().click();
  const after = await rows.count();
  expect(after).toBeLessThan(before);
  await expect(page).toHaveScreenshot("gantt-collapsed.png", { fullPage: true });
});

test("масштаб: список задач слева остаётся на виду при горизонтальном скролле", async ({ page }) => {
  await mockYouTrack(page);
  await build(page);
  // колонка задач — sticky внутри скролл-контейнера
  const sticky = await page.locator("[data-tid='gantt-labels']").first()
    .evaluate((el) => ({ position: getComputedStyle(el).position, left: getComputedStyle(el).left }));
  expect(sticky.position).toBe("sticky");
  expect(Number.parseFloat(sticky.left)).toBe(0);
  // скроллим ось вправо: колонка задач не смещается
  const labelsBox = await page.locator("[data-tid='gantt-labels']").first().boundingBox();
  await page.locator("[data-tid='gantt-svg']").first().hover();
  await page.mouse.wheel(600, 0);
  await page.waitForTimeout(300);
  const labelsBoxAfter = await page.locator("[data-tid='gantt-labels']").first().boundingBox();
  expect(labelsBoxAfter!.x).toBeCloseTo(labelsBox!.x, 0);
  await expect(page).toHaveScreenshot("gantt-sticky.png", { fullPage: true });
});

test("масштаб: кнопки «−»/«+» меняют ширину дня, «8 недель» возвращает авто", async ({ page }) => {
  await mockYouTrack(page);
  await build(page);
  const svg = page.locator("[data-tid='gantt-svg']").first();
  const auto = Number(await svg.getAttribute("width"));
  const zoomLabel = page.locator(".zoom-label");
  // авто-масштаб: 8 недель на экране
  await expect(zoomLabel).toContainText("8 нед");
  // «+» — день шире, «−» — уже; «8 недель» возвращает авто
  await page.getByRole("button", { name: "Увеличить масштаб" }).click();
  const wider = Number(await svg.getAttribute("width"));
  expect(wider).toBeGreaterThan(auto);
  await expect(zoomLabel).toContainText("6 нед");
  await page.getByRole("button", { name: "Уменьшить масштаб" }).click();
  expect(Number(await svg.getAttribute("width"))).toBeCloseTo(auto, 0);
  await page.getByRole("button", { name: "8 недель" }).click();
  expect(Number(await svg.getAttribute("width"))).toBe(auto);
  // повторное увеличение — для скриншота увеличенного вида
  await page.getByRole("button", { name: "Увеличить масштаб" }).click();
  await expect(svg).toBeVisible();
  await expect(page).toHaveScreenshot("gantt-zoom.png", { fullPage: true });
});

test("диаграмма: факт работы — бар факта и длительность к.д./р.д.", async ({ page }) => {
  await mockYouTrack(page);
  await build(page);
  // у каждой задачи — текст реальной длительности «N к.д. / M р.д.»
  const factText = page.locator("[data-tid='gantt-svg'] text").filter({ hasText: /к\.д\. \/ \d+ р\.д\./ });
  await expect(factText.first()).toBeVisible();
  await expect(factText).toHaveCount(3);
  await expect(page).toHaveScreenshot("gantt-actual.png", { fullPage: true });
});

test("fallback размера: тикет без Size — M* и предупреждение", async ({ page }) => {
  await mockYouTrack(page);
  await build(page);
  await expect(page.locator(".summary-row")).toContainText("Задач: 3");
  await expect(page.locator(".problems")).toContainText("Предупреждения");
  // список свёрнут — раскрываем и проверяем содержимое
  await page.locator(".problems").getByRole("button").or(page.locator(".problems a")).first().click();
  await expect(page.locator(".problems")).toContainText("принят размер M");
  await expect(page).toHaveScreenshot("gantt-size-fallback.png", { fullPage: true });
});
