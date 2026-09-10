// Unit-тесты YouTrack-клиента: fetchIssue, fetchBatch (_history), computeActualStart, метаданные.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchIssue, fetchBatch, computeActualStart, collectMetaFromIssues, collectLinkTypes, cache } from "../src/lib/youtrack";
import { childIdsOf } from "../src/lib/tree";
import type { Issue } from "../src/lib/constants";

// PROXY зависит от location — в node-окружении vitest его нет → прямой запрос невозможен.
// Для юнит-тестов мокаем global.fetch и проверяем разбор ответов, не URL.
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
const mkBase = { id: "A", summary: "", sizeRaw: null, links: [], resolved: false, resolvedAt: null, _fieldValues: [] } as Issue;

describe("fetchIssue", () => {
  beforeEach(() => cache.clear());

  it("парсит issue: поля, links, resolved", async () => {
    vi.stubGlobal("fetch", vi.fn(() => ok({
      idReadable: "INFRA-1",
      summary: "Сделать всё",
      resolved: "2026-08-10T00:00:00.000Z",
      customFields: [
        { name: "Size", value: { name: "L" } },
        { name: "State", value: { name: "Resolved" } },
      ],
      links: [{
        direction: "OUTBOUND",
        linkType: { name: "Subtask", sourceToTarget: "parent for", targetToSource: "subtask of" },
        issues: [{ idReadable: "INFRA-2" }, { idReadable: "infra-3" }],
      }],
    })));
    const issue = await fetchIssue("https://yt.x", "tok", "INFRA-1", "Size");
    expect(issue.id).toBe("INFRA-1");
    expect(issue.sizeRaw).toBe("L");
    expect(issue.resolved).toBe(true);
    expect(issue.resolvedAt).toBeInstanceOf(Date);
    expect(issue.links[0].ids).toEqual(["INFRA-2", "INFRA-3"]);
    expect(issue._fieldValues).toEqual(["Size", "State"]);
    vi.unstubAllGlobals();
  });

  it("404 → понятная ошибка", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 404 } as Response)));
    await expect(fetchIssue("https://yt.x", "tok", "NOPE-1", "Size")).rejects.toThrow("не найден");
    vi.unstubAllGlobals();
  });

  it("401 → ошибка с кодом", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 401 } as Response)));
    await expect(fetchIssue("https://yt.x", "tok", "X", "Size")).rejects.toMatchObject({ code: 401 });
    vi.unstubAllGlobals();
  });

  it("Size-значение строкой тоже разбирается", async () => {
    vi.stubGlobal("fetch", vi.fn(() => ok({
      idReadable: "A-1", summary: "", resolved: null,
      customFields: [{ name: "Size", value: "M" }], links: [],
    })));
    const issue = await fetchIssue("https://yt.x", "tok", "A-1", "Size");
    expect(issue.sizeRaw).toBe("M");
    vi.unstubAllGlobals();
  });
});

describe("computeActualStart — факт из сохранённой истории", () => {
  const mk = (history: object[]): Issue => ({
    id: "X-1", summary: "", sizeRaw: null, links: [], resolved: false, resolvedAt: null,
    _fieldValues: [], _history: history as Issue["_history"],
  });

  it("самое раннее вхождение статуса; чужие поля игнорируются; статусы собираются", () => {
    const issue = mk([
      { ts: new Date("2026-08-01T10:00:00Z"), field: "State", added: ["Open"], removed: [] },
      { ts: new Date("2026-08-02T10:00:00Z"), field: "Assignee", added: ["Иванов"], removed: [] },
      { ts: new Date("2026-08-03T09:00:00Z"), field: "State", added: ["Doing"], removed: ["Open"] },
      { ts: new Date("2026-08-05T12:00:00Z"), field: "State", added: ["Doing"], removed: ["Paused"] },
      { ts: new Date("2026-08-10T00:00:00Z"), field: "State", added: ["Resolved"], removed: ["Doing"] },
    ]);
    const r = computeActualStart(issue, "State", "Doing");
    expect(r!.toISOString().slice(0, 10)).toBe("2026-08-03");
    expect([...issue._statuses!].sort()).toEqual(["Doing", "Open", "Paused", "Resolved"]);
  });

  it("нет статуса → null; истории нет → null", () => {
    expect(computeActualStart(mk([]), "State", "Missing")).toBeNull();
    expect(computeActualStart({ id: "X", summary: "", sizeRaw: null, links: [], resolved: false, resolvedAt: null, _fieldValues: [] }, "State", "Open")).toBeNull();
  });

  it("повторный расчёт с другим статусом на том же тикете — другая дата (перестроение графика)", () => {
    const issue = mk([
      { ts: new Date("2026-08-03T09:00:00Z"), field: "State", added: ["Doing"], removed: ["Open"] },
      { ts: new Date("2026-08-10T00:00:00Z"), field: "State", added: ["Resolved"], removed: ["Doing"] },
    ]);
    expect(computeActualStart(issue, "State", "Doing")!.toISOString().slice(0, 10)).toBe("2026-08-03");
    expect(computeActualStart(issue, "State", "Open")).toBeNull();
  });

  it("события без имени поля не считаются переходами выбранного статуса", () => {
    const issue = mk([
      { ts: new Date("2026-08-01T00:00:00Z"), field: "", added: ["Open"], removed: [] },
      { ts: new Date("2026-08-02T00:00:00Z"), field: "", added: ["Иванов"], removed: [] },
    ]);
    expect(computeActualStart(issue, "State", "Open")).toBeNull();
    expect([...issue._statuses!]).toEqual([]);
  });
});

describe("fetchBatch — история сохраняется при загрузке", () => {
  beforeEach(() => cache.clear());

  const issueOk = (url: string): ReturnType<typeof ok> => {
    if (/activities|history/.test(url))
      return ok([{ timestamp: "2026-09-02T10:00:00Z", field: { name: "State" }, added: [{ name: "In Progress" }], removed: [] }]);
    if (/BROKEN-9/.test(url))
      return Promise.resolve({ ok: false, status: 404 } as Response);
    return ok({ idReadable: "A-1", summary: "", resolved: null, customFields: [], links: [] });
  };

  it("тикет попадает в кеш вместе с _history; ошибки загрузки — в problems и в onNetworkError", async () => {
    const netErrors: string[] = [];
    vi.stubGlobal("fetch", vi.fn(issueOk));
    const problems: string[] = [];
    await fetchBatch(["A-1", "BROKEN-9"],
      { base: "https://yt.x", token: "t", sizeField: "Size", onNetworkError: (m) => netErrors.push(m) }, problems);
    const issue = cache.get("A-1")!;
    expect(issue).toBeTruthy();
    expect(issue._history).toHaveLength(1);
    expect(issue._history![0].field).toBe("State");
    expect(issue._history![0].added).toEqual(["In Progress"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("BROKEN-9");
    expect(netErrors).toEqual(problems); // каждая ошибка уходит и в Toast-канал
    vi.unstubAllGlobals();
  });

  it("ошибка истории (HTTP 500) — не молчим: problems + onNetworkError, _history пуст", async () => {
    const netErrors: string[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string) =>
      /activities|history/.test(url)
        ? Promise.resolve({ ok: false, status: 500 } as Response)
        : ok({ idReadable: "A-1", summary: "", resolved: null, customFields: [], links: [] })));
    const problems: string[] = [];
    await fetchBatch(["A-1"],
      { base: "https://yt.x", token: "t", sizeField: "Size", onNetworkError: (m) => netErrors.push(m) }, problems);
    expect(cache.get("A-1")!._history).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("A-1");
    expect(problems[0]).toContain("HTTP 500");
    expect(netErrors).toEqual(problems);
    vi.unstubAllGlobals();
  });

  it("403 на историю — понятная причина в ошибке", async () => {
    const netErrors: string[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string) =>
      /activities|history/.test(url)
        ? Promise.resolve({ ok: false, status: 403 } as Response)
        : ok({ idReadable: "A-1", summary: "", resolved: null, customFields: [], links: [] })));
    const problems: string[] = [];
    await fetchBatch(["A-1"],
      { base: "https://yt.x", token: "t", sizeField: "Size", onNetworkError: (m) => netErrors.push(m) }, problems);
    expect(problems[0]).toMatch(/403.*токен|токен.*403/s);
    vi.unstubAllGlobals();
  });

  it("сбой сети (fetch reject) на историю — текст ошибки доходит до problems", async () => {
    const netErrors: string[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string) =>
      /activities|history/.test(url)
        ? Promise.reject(new Error("net down"))
        : ok({ idReadable: "A-1", summary: "", resolved: null, customFields: [], links: [] })));
    const problems: string[] = [];
    await fetchBatch(["A-1"],
      { base: "https://yt.x", token: "t", sizeField: "Size", onNetworkError: (m) => netErrors.push(m) }, problems);
    expect(problems[0]).toContain("net down");
    expect(netErrors).toEqual(problems);
    vi.unstubAllGlobals();
  });
});

describe("метаданные из кеша", () => {
  beforeEach(() => cache.clear());

  it("collectMetaFromIssues: поля + статусы", () => {
    cache.set("A-1", { id: "A-1", summary: "", sizeRaw: null, links: [], resolved: false, resolvedAt: null,
      _fieldValues: ["Size", "State", "Priority"],
      _history: [{ ts: null, field: "State", added: ["Doing"], removed: ["Open"] }] });
    cache.set("B-1", { id: "B-1", summary: "", sizeRaw: null, links: [], resolved: false, resolvedAt: null,
      _fieldValues: ["State"] });
    const meta = collectMetaFromIssues();
    expect(meta.fieldNames.sort()).toEqual(["Priority", "Size", "State"]);
    expect(meta.statuses.sort()).toEqual(["Doing", "Open"]);
  });

  it("collectLinkTypes: уникальные имена с обеих сторон", () => {
    cache.set("A-1", { id: "A-1", summary: "", sizeRaw: null, links: [
      { dir: "OUT", name: "Subtask", stt: "parent for", tts: "subtask of", ids: [] },
      { dir: "OUT", name: "Depend", stt: "depends on", tts: "required for", ids: [] },
    ], resolved: false, resolvedAt: null, _fieldValues: [] });
    expect(collectLinkTypes()).toEqual(["Depend", "Subtask", "depends on", "parent for", "required for", "subtask of"]);
  });
});

// --- реальный ответ YouTrack: yt/api/issues/INFRA-12575 (обрезан до значимых частей) ---
const INFRA_12575 = {
  idReadable: "INFRA-12575",
  summary: "Houston2: 2026Q2.  Оптимизация работы с ресурсами",
  resolved: null,
  links: [
    {
      direction: "BOTH",
      linkType: { sourceToTarget: "relates to", targetToSource: "relates to", name: "Relates", $type: "IssueLinkType" },
      issues: [{ idReadable: "bi_proj-761", $type: "Issue" }],
      $type: "IssueLink",
    },
    {
      direction: "OUTWARD",
      linkType: { sourceToTarget: "parent for", targetToSource: "subtask of", name: "Subtask", $type: "IssueLinkType" },
      issues: [{ idReadable: "INFRA-12031", $type: "Issue" }, { idReadable: "INFRA-12056", $type: "Issue" }],
      $type: "IssueLink",
    },
    {
      direction: "INWARD",
      linkType: { sourceToTarget: "parent for", targetToSource: "subtask of", name: "Subtask", $type: "IssueLinkType" },
      issues: [],
      $type: "IssueLink",
    },
    {
      direction: "OUTWARD",
      linkType: { sourceToTarget: "is required for", targetToSource: "depends on", name: "Depend", $type: "IssueLinkType" },
      issues: [],
      $type: "IssueLink",
    },
    {
      direction: "BOTH",
      linkType: { sourceToTarget: "staging", targetToSource: "", name: "staging", $type: "IssueLinkType" },
      issues: [],
      $type: "IssueLink",
    },
    {
      direction: "BOTH",
      linkType: { sourceToTarget: "родитель для", targetToSource: "родитель для", name: "Родитель для", $type: "IssueLinkType" },
      issues: [],
      $type: "IssueLink",
    },
  ],
  customFields: [
    {
      projectCustomField: {
        bundle: {
          values: ["Backlog", "Inbox", "To Do", "Analytics", "Doing", "Review", "Done", "Released",
            "Archived", "Rejected", "Processed inbox", "WaitRelease", "Paused"]
            .map((name) => ({ localizedName: null, name, $type: "StateBundleElement" })),
          $type: "StateBundle",
        },
        field: { name: "State", $type: "CustomField" },
        $type: "StateProjectCustomField",
      },
      value: { localizedName: null, name: "Doing", $type: "StateBundleElement" },
      name: "State",
      $type: "StateIssueCustomField",
    },
    {
      projectCustomField: {
        bundle: {
          values: ["XS", "S", "M", "L", "XL", "XXL"].map((name) => ({ localizedName: null, name, $type: "EnumBundleElement" })),
          $type: "EnumBundle",
        },
        field: { name: "Size", $type: "CustomField" },
        $type: "EnumProjectCustomField",
      },
      value: null, // размер не задан
      name: "Size",
      $type: "SingleEnumIssueCustomField",
    },
    {
      // мультиполе: значение — МАССИВ
      projectCustomField: {
        bundle: {
          values: [{ localizedName: null, name: "Хостинг и деплой", $type: "EnumBundleElement" }],
          $type: "EnumBundle",
        },
        field: { name: "Field", $type: "CustomField" },
        $type: "EnumProjectCustomField",
      },
      value: [{ localizedName: null, name: "Хостинг и деплой", $type: "EnumBundleElement" }],
      name: "Field",
      $type: "MultiEnumIssueCustomField",
    },
    {
      // поле без бандла (Simple) — в _bundleValues попасть не должно
      value: null,
      projectCustomField: { field: { name: "H-приоритет", $type: "CustomField" }, $type: "SimpleProjectCustomField" },
      name: "H-приоритет",
      $type: "SimpleIssueCustomField",
    },
    {
      projectCustomField: {
        bundle: {
          values: [{ name: "Aleksandr Kazakov", $type: "User" }, { name: "Infrastructure developer", $type: "UserGroup" }],
          $type: "UserBundle",
        },
        field: { name: "Assignee", $type: "CustomField" },
        $type: "UserProjectCustomField",
      },
      value: { name: "Васильев Владислав Владимирович", $type: "User" },
      name: "Assignee",
      $type: "SingleUserIssueCustomField",
    },
  ],
  $type: "Issue",
};

describe("fetchIssue на реальном ответе YouTrack (INFRA-12575)", () => {
  beforeEach(() => cache.clear());

  it("парсит id/summary/resolved; id в верхнем регистре даже при строчных в связях", async () => {
    vi.stubGlobal("fetch", vi.fn(() => ok(INFRA_12575)));
    const issue = await fetchIssue("https://yt.x", "tok", "INFRA-12575", "Size");
    expect(issue.id).toBe("INFRA-12575");
    expect(issue.summary).toContain("Houston2");
    expect(issue.resolved).toBe(false);
    expect(issue.resolvedAt).toBeNull();
    // «bi_proj-761» в связи → в верхнем регистре, как и все _kids
    expect(issue.links[0].ids).toEqual(["BI_PROJ-761"]);
    vi.unstubAllGlobals();
  });

  it("Size не задан (value: null) → sizeRaw null; связи Subtask распознаны", async () => {
    vi.stubGlobal("fetch", vi.fn(() => ok(INFRA_12575)));
    const issue = await fetchIssue("https://yt.x", "tok", "INFRA-12575", "Size");
    expect(issue.sizeRaw).toBeNull();
    const subtask = issue.links.find((L) => L.name === "Subtask" && L.dir === "OUTWARD")!;
    expect(subtask.stt).toBe("parent for");
    expect(subtask.ids).toEqual(["INFRA-12031", "INFRA-12056"]);
    // пустой INWARD-двойник не приносит лишних связей
    const inward = issue.links.find((L) => L.name === "Subtask" && L.dir === "INWARD")!;
    expect(inward.ids).toEqual([]);
    // тип с пустым targetToSource («staging») парсится без ошибок
    const staging = issue.links.find((L) => L.name === "staging")!;
    expect(staging.tts).toBe("");
    vi.unstubAllGlobals();
  });

  it("бандлы: статусы воркфлоу и размеры в _bundleValues; поле без бандла — мимо", async () => {
    vi.stubGlobal("fetch", vi.fn(() => ok(INFRA_12575)));
    const issue = await fetchIssue("https://yt.x", "tok", "INFRA-12575", "Size");
    expect(issue._bundleValues!["State"]).toEqual(["Backlog", "Inbox", "To Do", "Analytics", "Doing",
      "Review", "Done", "Released", "Archived", "Rejected", "Processed inbox", "WaitRelease", "Paused"]);
    expect(issue._bundleValues!["Size"]).toEqual(["XS", "S", "M", "L", "XL", "XXL"]);
    expect(issue._bundleValues!["H-приоритет"]).toBeUndefined(); // Simple-поле без бандла
    expect(issue._fieldValues).toContain("State");
    vi.unstubAllGlobals();
  });

  it("мультиполе в качестве «Поля размера»: значение-массив → первый элемент", async () => {
    const multi = {
      ...INFRA_12575,
      customFields: INFRA_12575.customFields.map((f) =>
        f.name === "Size"
          ? { ...f, value: [{ localizedName: null, name: "L", $type: "EnumBundleElement" }], $type: "MultiEnumIssueCustomField" }
          : f),
    };
    vi.stubGlobal("fetch", vi.fn(() => ok(multi)));
    const issue = await fetchIssue("https://yt.x", "tok", "INFRA-12575", "Size");
    expect(issue.sizeRaw).toBe("L"); // раньше массив молча давал null → M-фолбэк
    vi.unstubAllGlobals();
  });

  it("дети по «parent for» и недириектальному «родитель для» (childIdsOf на реальных связях)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => ok(INFRA_12575)));
    const issue = await fetchIssue("https://yt.x", "tok", "INFRA-12575", "Size");
    expect(childIdsOf(issue, "parent for", false).sort()).toEqual(["INFRA-12031", "INFRA-12056"]);
    // BOTH-тип с одинаковыми stt/tts мэтчится по имени
    expect(childIdsOf(issue, "родитель для", false)).toEqual([]);
    // INWARD «subtask of» не уводит вверх при поиске детей по «parent for»
    expect(childIdsOf(issue, "subtask of", false)).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("collectMetaFromIssues: все 13 статусов State из бандла доходят до селекта", async () => {
    vi.stubGlobal("fetch", vi.fn(() => ok(INFRA_12575)));
    cache.set("INFRA-12575", await fetchIssue("https://yt.x", "tok", "INFRA-12575", "Size"));
    const meta = collectMetaFromIssues("State");
    expect(meta.fieldNames).toContain("State");
    expect(meta.statuses).toContain("Doing");
    expect(meta.statuses).toContain("WaitRelease");
    expect(meta.statuses).not.toContain("Васильев Владислав Владимирович"); // юзеры не статусы
    vi.unstubAllGlobals();
  });
});

describe("corner-case: URLs, ответы не-массивы, сбои fetchBatch, idsWithoutHistory", () => {
  beforeEach(() => cache.clear());

  it("пагинация истории: >pageSize страниц склеиваются до короткой страницы", async () => {
    // 250 событий: две полные страницы по 100 и короткая 50-я
    const mkEvents = (n: number) => Array.from({ length: n }, (_, i) => ({
      timestamp: Date.parse("2026-01-01T00:00:00Z") + i,
      field: { customField: { name: "State" } },
      added: [{ name: `S${i}` }], removed: [],
    }));
    const all = mkEvents(250);
    const calls: number[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (/activities/.test(url)) {
        const skip = Number(new URL(url, "https://x").searchParams.get("$skip"));
        calls.push(skip);
        return ok(all.slice(skip, skip + 100));
      }
      return ok({ idReadable: "A-1", summary: "", resolved: null, customFields: [], links: [] });
    }));
    const { fetchIssueHistory } = await import("../src/lib/youtrack");
    const r = await fetchIssueHistory("https://yt.x", "tok", "A-1");
    expect(r.error).toBeNull();
    expect(r.history).toHaveLength(250);
    expect(calls).toEqual([0, 100, 200]); // третья страница короткая — стоп
  });

  it("пагинация истории: ровно кратное pageSize число событий (2 полные страницы + пустая)", async () => {
    // 200 событий: вторая страница полная → цикл продолжается, третья пустая → стоп
    const mkEvents = (n: number) => Array.from({ length: n }, (_, i) => ({
      timestamp: i, field: { customField: { name: "State" } }, added: [{ name: `S${i}` }], removed: [],
    }));
    const all = mkEvents(200);
    const calls: number[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (/activities/.test(url)) {
        const skip = Number(new URL(url, "https://x").searchParams.get("$skip"));
        calls.push(skip);
        return ok(all.slice(skip, skip + 100));
      }
      return ok({ idReadable: "A-1", summary: "", resolved: null, customFields: [], links: [] });
    }));
    const { fetchIssueHistory } = await import("../src/lib/youtrack");
    const r = await fetchIssueHistory("https://yt.x", "tok", "A-1");
    expect(r.error).toBeNull();
    expect(r.history).toHaveLength(200);
    expect(calls).toEqual([0, 100, 200]);
    vi.unstubAllGlobals();
  });
  it("история: не-массив ответа — error с текстом", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) =>
      /activities/.test(url) ? ok({ unexpected: true }) : ok({ idReadable: "A-1", summary: "", resolved: null, customFields: [], links: [] })));
    const { fetchIssueHistory } = await import("../src/lib/youtrack");
    const r = await fetchIssueHistory("https://yt.x", "tok", "A-1");
    expect(r.history).toEqual([]);
    expect(r.error).toContain("ожидался массив");
    vi.unstubAllGlobals();
  });

  it("fetchBatch: ошибка тикета не 401/403 (500) — report, обход продолжается", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 500 } as Response)));
    const problems: string[] = [];
    await expect(fetchBatch(["A-1"],
      { base: "https://yt.x", token: "t", sizeField: "Size" }, problems)).resolves.toBeUndefined();
    expect(problems[0]).toContain("HTTP 500");
    vi.unstubAllGlobals();
  });

  it("fetchBatch: 403 на тикет — исключение (продолжать бессмысленно)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 403 } as Response)));
    const problems: string[] = [];
    await expect(fetchBatch(["A-1"],
      { base: "https://yt.x", token: "t", sizeField: "Size" }, problems)).rejects.toMatchObject({ code: 403 });
    expect(problems[0]).toContain("A-1");
    vi.unstubAllGlobals();
  });

  it("fetchBatch: сгенерированный текст «ошибка загрузки» для не-Error reason", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject("строка-причина")));
    const problems: string[] = [];
    await expect(fetchBatch(["A-1"],
      { base: "https://yt.x", token: "t", sizeField: "Size" }, problems)).resolves.toBeUndefined();
    expect(problems[0]).toContain("ошибка загрузки");
    vi.unstubAllGlobals();
  });

  it("idsWithoutHistory: только тикеты без _history", async () => {
    cache.clear();
    cache.set("A", { ...mkBase, _history: [{ ts: null, field: "x", added: [], removed: [] }] });
    cache.set("B", { ...mkBase, id: "B", _history: [] });
    cache.set("C", { ...mkBase, id: "C" }); // _history undefined
    const { idsWithoutHistory } = await import("../src/lib/youtrack");
    expect(idsWithoutHistory([...cache.values()])).toEqual(["B", "C"]);
  });
});

describe("fetchBatch — corner-case ветки rejected", () => {
  beforeEach(() => cache.clear());

  it("история fetch-reject при удачном тикете: problems + _history пуст", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) =>
      /activities/.test(url)
        ? Promise.reject(new Error("history net down"))
        : ok({ idReadable: "A-1", summary: "", resolved: null, customFields: [], links: [] })));
    const problems: string[] = [];
    await fetchBatch(["A-1"], { base: "https://yt.x", token: "t", sizeField: "Size" }, problems);
    expect(cache.get("A-1")!._history).toEqual([]);
    expect(problems[0]).toContain("history net down");
    vi.unstubAllGlobals();
  });

  it("сам тикет fetch-reject c не-Error reason: «ошибка загрузки», без throw", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject("boOM")));
    const problems: string[] = [];
    await expect(fetchBatch(["A-1"], { base: "https://yt.x", token: "t", sizeField: "Size" }, problems))
      .resolves.toBeUndefined();
    expect(problems[0]).toBe("A-1: ошибка загрузки");
    vi.unstubAllGlobals();
  });
});

describe("fetchBatch — защита от reject'а источника истории (historyFn-инъекция)", () => {
  beforeEach(() => cache.clear());

  it("h.status === rejected → _history пуст, reason из Error", async () => {
    vi.stubGlobal("fetch", vi.fn(() => ok({ idReadable: "A-1", summary: "", resolved: null, customFields: [], links: [] })));
    const problems: string[] = [];
    // historyFn-инъекция: защита fetchBatch от reject'а источника истории
    await fetchBatch(["A-1"], {
      base: "https://yt.x", token: "t", sizeField: "Size",
      historyFn: () => Promise.reject(new Error("mocked reject")) as never,
    }, problems);
    expect(cache.get("A-1")!._history).toEqual([]);
    expect(problems[0]).toContain("mocked reject");
    vi.unstubAllGlobals();
  });

  it("h.status === rejected, reason не Error → «сетевая ошибка»", async () => {
    vi.stubGlobal("fetch", vi.fn(() => ok({ idReadable: "A-2", summary: "", resolved: null, customFields: [], links: [] })));
    const problems: string[] = [];
    await fetchBatch(["A-2"], {
      base: "https://yt.x", token: "t", sizeField: "Size",
      historyFn: () => Promise.reject("не ошибка") as never,
    }, problems);
    expect(cache.get("A-2")!._history).toEqual([]);
    expect(problems[0]).toContain("сетевая ошибка");
    vi.unstubAllGlobals();
  });
});
