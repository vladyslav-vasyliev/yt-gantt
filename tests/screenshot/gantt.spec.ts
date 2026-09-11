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

  // корень вводится как «1» → запрос на /issues/INFRA-1, ответ с idReadable INFRA-1
  await page.route("**/yt/api/issues/INFRA-1?*", (route) =>
    route.fulfill(mkIssue({
      idReadable: "INFRA-1",
      summary: "Родительская задача: подготовить релиз",
      resolved: resolved ? "2026-09-10T00:00:00.000Z" : null,
      customFields: [
        { name: "Size", value: { name: "L" } },
        { name: "State", value: { name: "Doing" } },
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
    await page.route("**/yt/api/issues/INFRA-1/activities?*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify([
          { timestamp: "2026-09-05T09:00:00Z", field: { name: "State" }, added: [{ name: "Open" }], removed: [] },
          { timestamp: "2026-09-06T10:00:00Z", field: { name: "State" }, added: [{ name: "Doing" }], removed: [{ name: "Open" }] },
        ]),
      }));
    // История пользовательских полей через документированный activities endpoint.
    await page.route("**/yt/api/issues/INFRA-2/activities?*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify([
          { timestamp: "2026-09-04T09:00:00Z", field: { name: "State" }, added: [{ name: "Open" }], removed: [] },
          { timestamp: "2026-09-07T10:00:00Z", field: { name: "State" }, added: [{ name: "Doing" }], removed: [{ name: "Open" }] },
        ]),
      }));
    // История пользовательских полей через документированный activities endpoint.
    await page.route("**/yt/api/issues/INFRA-3/activities?*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify([
          { timestamp: "2026-09-06T09:00:00Z", field: { name: "State" }, added: [{ name: "Open" }], removed: [] },
          { timestamp: "2026-09-09T10:00:00Z", field: { name: "State" }, added: [{ name: "Doing" }], removed: [{ name: "Open" }] },
        ]),
      }));
  }
}

// Сценарий INFRA: дерево INFRA-1 → (INFRA-2, INFRA-3), INFRA-3 → (INFRA-4, INFRA-5)
// с фактами Doing/Resolved. Проверяет, что родитель начинается от самого раннего
// начала работ среди себя и детей и завершается не раньше позднего ребёнка.
const INFRA_FACTS: Record<string, { doing: string; resolved: string; kids: string[] }> = {
  "INFRA-1": { doing: "2026-09-08T10:00:00Z", resolved: "2026-09-11T00:00:00.000Z", kids: ["INFRA-2", "INFRA-3"] },
  "INFRA-2": { doing: "2026-09-07T10:00:00Z", resolved: "2026-09-09T00:00:00.000Z", kids: [] },
  "INFRA-3": { doing: "2026-09-08T10:00:00Z", resolved: "2026-09-15T00:00:00.000Z", kids: ["INFRA-4", "INFRA-5"] },
  "INFRA-4": { doing: "2026-09-09T10:00:00Z", resolved: "2026-09-10T00:00:00.000Z", kids: [] },
  "INFRA-5": { doing: "2026-09-14T10:00:00Z", resolved: "2026-09-18T00:00:00.000Z", kids: [] },
};

async function mockInfraTree(page: Page): Promise<void> {
  for (const [id, fact] of Object.entries(INFRA_FACTS)) {
    await page.route(`**/yt/api/issues/${id}?*`, (route) =>
      route.fulfill(mkIssue({
        idReadable: id,
        summary: `Задача ${id}`,
        resolved: fact.resolved,
        customFields: [
          { name: "Size", value: { name: "M" } },
          { name: "State", value: { name: "Doing" } },
        ],
        links: fact.kids.length ? [{
          direction: "OUTBOUND",
          linkType: { name: "Subtask", sourceToTarget: "parent for", targetToSource: "subtask of" },
          issues: fact.kids.map((k) => ({ idReadable: k })),
        }] : [],
      })));
    await page.route(`**/yt/api/issues/${id}/activities?*`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify([
          { timestamp: fact.doing, field: { name: "State" }, added: [{ name: "Doing" }], removed: [{ name: "Open" }] },
        ]),
      }));
  }
}

// длинное дерево (родитель + 12 детей) — чтобы страница прокручивалась
async function mockLongTree(page: Page): Promise<void> {
  const kids = Array.from({ length: 12 }, (_, i) => `INFRA-${i + 2}`);
  await page.route("**/yt/api/issues/INFRA-1?*", (route) => route.fulfill(mkIssue({
    idReadable: "INFRA-1",
    summary: "Родительская задача",
    resolved: null,
    customFields: [
      { name: "Size", value: { name: "L" } },
      { name: "State", value: { name: "Doing" } },
    ],
    links: [{
      direction: "OUTBOUND",
      linkType: { name: "Subtask", sourceToTarget: "parent for", targetToSource: "subtask of" },
      issues: kids.map((k) => ({ idReadable: k })),
    }],
  })));
  await page.route("**/yt/api/issues/INFRA-1/activities?*", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }));
  for (const k of kids) {
    await page.route(`**/yt/api/issues/${k}?*`, (route) => route.fulfill(mkIssue({
      idReadable: k, summary: `Дочерняя ${k}`, resolved: null,
      customFields: [{ name: "Size", value: { name: "S" } }], links: [],
    })));
    await page.route(`**/yt/api/issues/${k}/activities?*`, (route) =>
      route.fulfill({ contentType: "application/json", body: "[]" }));
  }
}

// MUI Tab имеет role="tab"
const tab = (page: Page, name: string) => page.getByRole("tab", { name });
async function build(page: Page): Promise<void> {
  await page.goto("/");
  // токен — на табе «Настройки»
  await tab(page, "Настройки").click();
  await page.fill("#token", "perm:test");
  // по умолчанию открыт таб «Задачи»
  await tab(page, "Задачи").click();
  await page.fill("#ids", "INFRA-1");
  // «Загрузить задачи» сразу строит график — отдельной кнопки «Построить» нет
  await page.getByRole("button", { name: "Загрузить задачи" }).click();
  await expect(page.locator("[data-tid='gantt-svg']").first()).toBeVisible({ timeout: 15000 });
}

test.beforeEach(async ({ context, page }) => {
  // фиксируем ВЕСЬ clock, а не только Date.now: приложение читает дату через
  // new Date(), иначе после полуночи «сегодня» на диаграмме уезжает и снапшоты
  // перестают сходиться (page.clock.setFixedTime подменяет и Date, но не таймеры)
  await context.addInitScript(`Date.now = () => ${NOW};`);
  await page.clock.setFixedTime(new Date(NOW));
});

test("смена лямбды начала работ пересчитывает факт при повторной загрузке", async ({ page }) => {
  await mockYouTrack(page);
  await page.route("**/yt/api/issues/INFRA-1?*", (route) => route.fulfill(mkIssue({
    idReadable: "INFRA-1", summary: "Field selection", resolved: null, links: [],
    customFields: [
      { name: "Size", value: { name: "M" } },
      { name: "State", value: { name: "Doing" } },
      { name: "Workflow", value: { name: "Doing" } },
    ],
  })));
  await page.route("**/yt/api/issues/**/activities?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    expect(params.get("categories")).toBe("CustomFieldCategory");
    expect(params.get("fields")).toContain("customField(name)");
    await route.fulfill(mkIssue([
      { timestamp: Date.parse("2026-09-04T10:00:00Z"), field: { customField: { name: "State" } }, added: { name: "Doing" } },
      { timestamp: Date.parse("2026-09-01T10:00:00Z"), field: { customField: { name: "Workflow" } }, added: [{ name: "Doing" }] },
    ]));
  });
  await build(page);
  const fact = page.locator("[data-tid='gantt-svg'] text").filter({ hasText: /к\.д\./ });
  // дефолтная лямбда берёт самый ранний переход в Doing — 01.09 (Workflow)
  await expect(fact).toHaveText("4 к.д. / 4 р.д.");
  // другая лямбда: поле State (переход 04.09) + повторная загрузка перестраивает
  await tab(page, "Настройки").click();
  await page.fill("#startLambda", "(issue, activities) => activities.find(a => a.field === 'State')?.ts ?? null");
  await tab(page, "Задачи").click();
  await page.getByRole("button", { name: "Загрузить задачи" }).click();
  await expect(fact).toHaveText("1 к.д. / 1 р.д.");
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
  // URL и токен — на табе «Настройки»
  await tab(page, "Настройки").click();
  await page.fill("#baseUrl", "");
  // валидация срабатывает на «Загрузить задачи»
  await tab(page, "Задачи").click();
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

test("диаграмма: сценарий INFRA — родитель от самого раннего начала среди себя и детей", async ({ page }) => {
  await mockInfraTree(page);
  await build(page);
  // порядок DFS: родитель, затем дети и внуки
  const order = (await page.locator("[data-tid='gantt-labels'] text").allTextContents())
    .map((t) => (t.match(/INFRA-\d/) || [""])[0]).filter(Boolean);
  expect(order).toEqual(["INFRA-1", "INFRA-2", "INFRA-3", "INFRA-4", "INFRA-5"]);

  // план родительских обёрток: INFRA-1 07.09–18.09, INFRA-3 08.09–18.09
  const planOf = (id: string) =>
    page.locator("tr").filter({ hasText: id }).locator("[data-tid='gantt-svg'] title", { hasText: "план" });
  await expect(planOf("INFRA-1")).toContainText("07.09.2026 — 18.09.2026");
  await expect(planOf("INFRA-3")).toContainText("08.09.2026 — 18.09.2026");

  // ГЕОМЕТРИЯ: сплошной бар (факт, нижняя дорожка y=19) должен начинаться
  // ровно на дате из ожидаемого дерева. Масштаб выводим из подписей оси:
  // подписи стоят на x = index*dayPx + 3, поэтому barX(07.09) = x("07 сент") - 3.
  const axisX = async (label: string): Promise<number> =>
    Number(await page.locator("[data-tid='gantt-axis'] text").filter({ hasText: label }).first().getAttribute("x"));
  const x07 = await axisX("07 сент");
  const x14 = await axisX("14 сент");
  const dayPx = (x14 - x07) / 7;
  const xOn = (day: number): number => x07 - 3 + (day - 7) * dayPx;
  const planBarX = async (id: string): Promise<number> =>
    Number(await page.locator("tr").filter({ hasText: id })
      .locator("[data-tid='gantt-svg'] rect[y='5']").getAttribute("x"));

  const factBarX = async (id: string): Promise<number> =>
    Number(await page.locator("tr").filter({ hasText: id })
      .locator("[data-tid='gantt-svg'] rect[y='19']").getAttribute("x"));

  expect(await planBarX("INFRA-1")).toBeCloseTo(xOn(7), 0);  // 07.09
  expect(await planBarX("INFRA-2")).toBeCloseTo(xOn(7), 0);  // 07.09
  expect(await planBarX("INFRA-3")).toBeCloseTo(xOn(8), 0);  // 08.09
  expect(await planBarX("INFRA-4")).toBeCloseTo(xOn(9), 0);  // 09.09
  expect(await planBarX("INFRA-5")).toBeCloseTo(xOn(14), 0);  // 14.09
  
  expect(await factBarX("INFRA-1")).toBeCloseTo(xOn(7), 0);  // 07.09
  expect(await factBarX("INFRA-2")).toBeCloseTo(xOn(7), 0);  // 07.09
  expect(await factBarX("INFRA-3")).toBeCloseTo(xOn(8), 0);  // 08.09
  expect(await factBarX("INFRA-4")).toBeCloseTo(xOn(9), 0);  // 09.09
  expect(await factBarX("INFRA-5")).toBeCloseTo(xOn(14), 0); // 14.09

  await expect(page).toHaveScreenshot("gantt-infra-scenario.png", { fullPage: true });
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

test("лямбда размера: тикет без Size — дефолт 10 дн. без предупреждений", async ({ page }) => {
  await mockYouTrack(page);
  await build(page);
  await expect(page.locator(".summary-row")).toContainText("Задач: 3");
  // дефолтная лямбда размера молча заменяет неизвестное значение на 10 дней —
  // предупреждений нет
  await expect(page.locator(".problems")).toHaveCount(0);
  // кастомная лямбда: размер = длина summary
  await tab(page, "Настройки").click();
  await page.fill("#sizeLambda", "(issue, activities) => issue.summary.length > 3 ? 5 : 7");
  await tab(page, "Задачи").click();
  await page.getByRole("button", { name: "Загрузить задачи" }).click();
  await expect(page.locator(".summary-row")).toContainText("Задач: 3");
  await page.locator("[data-tid='gantt-svg'] text").filter({ hasText: /^5д$/ }).first().isVisible();
  await expect(page).toHaveScreenshot("gantt-size-fallback.png", { fullPage: true });
});

test("сломанная лямбда: тост и предупреждение, расчёт не падает", async ({ page }) => {
  await mockYouTrack(page);
  await build(page);
  await tab(page, "Настройки").click();
  await page.fill("#sizeLambda", "(issue, activities) => { throw new Error('boom'); }");
  await tab(page, "Задачи").click();
  await page.getByRole("button", { name: "Загрузить задачи" }).click();
  await page.locator(".problems a").click();
  await expect(page.locator(".problems")).toContainText("лямбда «Размер»");
  await expect(page.locator(".problems")).toContainText("принят размер 10 дн.");
  // диаграмма построена — все задачи с дефолтным размером
  await expect(page.locator("[data-tid='gantt-svg']").first()).toBeVisible();
});

test("при скроле заголовок, панель масштаба и шкала дат прилипают к верху", async ({ page }) => {
  await mockLongTree(page);
  await build(page);
  // приближаем, чтобы у шкалы дат появился горизонтальный скролл
  const plus = page.getByRole("button", { name: "Увеличить масштаб" });
  for (let i = 0; i < 20 && !(await plus.isDisabled()); i++) await plus.click();
  // узкий экран, чтобы страница прокручивалась
  await page.setViewportSize({ width: 1280, height: 500 });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(200);

  const appbar = page.locator("header.MuiAppBar-root");
  const zoombar = page.locator(".zoombar");
  const appbarBox = await appbar.boundingBox();
  const zoombarBox = await zoombar.boundingBox();
  // заголовок прилип к верху, панель масштаба — ровно под ним
  expect(appbarBox!.y).toBeCloseTo(0, 0);
  expect(zoombarBox!.y).toBeCloseTo(appbarBox!.height, 0);
  await expect(appbar).toContainText("Диаграмма Ганта");
  await expect(zoombar.getByRole("button", { name: "Увеличить масштаб" })).toBeInViewport();
  // легенда шкалы дат тоже прилипла и видна под шапкой
  const axis = page.locator("[data-tid='gantt-axis']");
  await expect(axis).toBeInViewport();
  const axisBox = await axis.boundingBox();
  expect(axisBox!.y).toBeGreaterThanOrEqual(appbarBox!.height);

  // горизонтальный скролл тела двигает шкалу дат синхронно
  await page.locator(".gantt-scroll").hover();
  await page.mouse.wheel(500, 0);
  await page.waitForTimeout(200);
  const sync = await page.evaluate(() => ({
    body: (document.querySelector(".gantt-scroll") as HTMLElement).scrollLeft,
    axis: (document.querySelector(".gantt-axis-viewport") as HTMLElement).scrollLeft,
  }));
  expect(sync.body).toBeGreaterThan(0);
  expect(sync.axis).toBe(sync.body);

  await expect(page).toHaveScreenshot("gantt-sticky-header.png");
});
