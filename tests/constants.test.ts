// Unit-тесты чистых функций: parseIds, applyProjectPrefix, даты, настройки.
import { describe, it, expect, vi } from "vitest";
import {
  parseIds, applyProjectPrefix, isWeekend, nextWorkday, issueUrl,
  calendarDaysBetween, workdaysBetween, factSpan, withCurrent, fitWeeks, clampDayPx,
  SIZE_MAP, loadSettings, saveSettings, type AppSettings, type Issue,
} from "../src/lib/constants";

describe("parseIds", () => {
  it("разделяет по пробелу, запятой, точке с запятой и переводу строки", () => {
    expect(parseIds("A-1, B-2;C-3\nD-4 E-5")).toEqual(["A-1", "B-2", "C-3", "D-4", "E-5"]);
  });
  it("приводит к верхнему регистру и дедуплицирует", () => {
    expect(parseIds("infra-1 INFRA-1")).toEqual(["INFRA-1"]);
  });
  it("игнорирует мусор", () => {
    expect(parseIds("  ,,;\n")).toEqual([]);
  });
});

describe("applyProjectPrefix", () => {
  it("дополняет голые номера", () => {
    expect(applyProjectPrefix("101, 202", "INFRA")).toBe("INFRA-101, INFRA-202");
  });
  it("нормализует регистр существующего префикса", () => {
    expect(applyProjectPrefix("infra-5", "INFRA")).toBe("INFRA-5");
  });
  it("перезаписывает чужой префикс", () => {
    expect(applyProjectPrefix("PROJ-9", "INFRA")).toBe("INFRA-9");
  });
  it("правильный префикс не трогает", () => {
    expect(applyProjectPrefix("INFRA-7", "INFRA")).toBe("INFRA-7");
  });
  it("пустой префикс — строка без изменений", () => {
    expect(applyProjectPrefix("INFRA-1, 2", "")).toBe("INFRA-1, 2");
  });
  it("не цепляет числа внутри слов", () => {
    // «v2» без дефиса не задача
    expect(applyProjectPrefix("v2 5", "P")).toBe("v2 P-5");
  });
});

describe("dates", () => {
  it("isWeekend: сб/вс — да", () => {
    expect(isWeekend(new Date(2026, 8, 5))).toBe(true);  // суббота
    expect(isWeekend(new Date(2026, 8, 6))).toBe(true);  // воскресенье
    expect(isWeekend(new Date(2026, 8, 7))).toBe(false); // понедельник
  });
  it("nextWorkday: пятница → понедельник", () => {
    const fri = nextWorkday(new Date(2026, 8, 4)); // пятница
    expect(fri.getDay()).toBe(5);
    const sat = new Date(2026, 8, 5);
    expect(nextWorkday(sat).getDay()).toBe(1);
  });
  it("issueUrl: режет хвостовые слеши, кодирует id", () => {
    expect(issueUrl("https://yt.example.com/", "A 1")).toBe("https://yt.example.com/issue/A%201");
  });
  it("SIZE_MAP покрыт всеми размерами", () => {
    expect(Object.keys(SIZE_MAP).sort()).toEqual(["L", "M", "S", "XL", "XS", "XXL"]);
    expect(SIZE_MAP.M).toBe(10);
  });
});

describe("settings persistence", () => {
  it("save → load round-trip", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    const s: AppSettings = {
      baseUrl: "https://yt.x/", token: "perm:t", ids: "1,2", sizeField: "Size",
      stateField: "State", startStatus: "Doing", project: "infra",
      linkType: "parent for", skipWeekends: false,
    };
    saveSettings(s);
    const loaded = loadSettings();
    expect(loaded.baseUrl).toBe("https://yt.x/");
    expect(loaded.token).toBe("perm:t");
    expect(loaded.project).toBe("INFRA"); // нормализован в верхний регистр
    expect(loaded.skipWeekends).toBe(false);
    vi.unstubAllGlobals();
  });

  it("loadSettings при недоступном localStorage — дефолты", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    const s = loadSettings();
    expect(s.baseUrl).toBe("https://youtrack.instance");
    expect(s.sizeField).toBe("Size");
    vi.unstubAllGlobals();
  });
});

describe("фактическая длительность: factSpan, calendarDaysBetween, workdaysBetween", () => {
  const mk = (p: Partial<Issue>): Issue => ({
    id: "A-1", summary: "", sizeRaw: null, links: [],
    resolved: false, resolvedAt: null, _fieldValues: [], ...p,
  });
  // пн 2026-08-10 … вс 2026-08-16
  const MON = new Date(2026, 7, 10), SUN = new Date(2026, 7, 16);

  it("нет фактического старта — факта нет", () => {
    expect(factSpan(mk({}))).toBeNull();
  });

  it("в работе: конец = сегодня, факт открытый", () => {
    // старт вт 2026-09-01, сегодня пт 2026-09-04 → 4 к.д., 4 р.д.
    const s = factSpan(mk({ actualStart: new Date(2026, 8, 1) }), new Date(2026, 8, 4))!;
    expect(s.open).toBe(true);
    expect(calendarDaysBetween(s.start, s.end)).toBe(4);
    expect(workdaysBetween(s.start, s.end)).toBe(4);
  });

  it("завершённая: границы по resolvedAt, факт закрытый", () => {
    const s = factSpan(mk({
      actualStart: new Date(2026, 7, 10), resolved: true, actualEnd: new Date(2026, 7, 21),
    }))!;
    expect(s.open).toBe(false);
    expect(calendarDaysBetween(s.start, s.end)).toBe(12);
    expect(workdaysBetween(s.start, s.end)).toBe(10);
  });

  it("resolved без даты завершения — точка в старте", () => {
    const s = factSpan(mk({ actualStart: MON, resolved: true }))!;
    expect(s.open).toBe(false);
    expect(calendarDaysBetween(s.start, s.end)).toBe(1);
  });

  it("end раньше start (кривые данные) — бар схлопнут в один день", () => {
    const s = factSpan(mk({ actualStart: SUN, resolved: true, actualEnd: MON }))!;
    expect(calendarDaysBetween(s.start, s.end)).toBe(1);
  });

  it("calendarDaysBetween включает оба конца", () => {
    expect(calendarDaysBetween(MON, MON)).toBe(1);
    expect(calendarDaysBetween(MON, SUN)).toBe(7);
  });

  it("workdaysBetween считает только пн–пт", () => {
    expect(workdaysBetween(MON, SUN)).toBe(5);
    expect(workdaysBetween(SUN, SUN)).toBe(0);
    expect(workdaysBetween(MON, new Date(2026, 7, 14))).toBe(5); // пн–пт
  });
});

describe("withCurrent — элементы селекта с чистым value", () => {
  it("текущее значение вне списка добавляется с пометкой в label, но с чистым value", () => {
    const items = withCurrent(["Open", "Doing"], "In Progress", "In Progress");
    expect(items).toContainEqual({ value: "In Progress", label: "In Progress *" });
    // ComboBox сматует value — пустого поля не будет
    expect(items.find((i) => i.value === "In Progress")).toBeTruthy();
  });

  it("пустой список — фолбэк; текущее значение в списке не дублируется", () => {
    expect(withCurrent([], "State", "State")).toEqual([{ value: "State", label: "State" }]);
    expect(withCurrent(["Size", "Priority"], "Size", "Size")).toEqual([
      { value: "Priority", label: "Priority" },
      { value: "Size", label: "Size" },
    ]);
  });
});

describe("масштаб диаграммы: fitWeeks / clampDayPx", () => {
  it("по умолчанию 8 недель умещаются в доступную ширину", () => {
    // 892px области графика → 892/56 ≈ 15.93 px за день
    expect(fitWeeks(892)).toBeCloseTo(15.93, 2);
    expect(fitWeeks(560)).toBe(10); // ровно 8 недель
    expect(fitWeeks(280, 5)).toBe(8); // кастомное число недель
  });

  it("ограничения: не мельче 3px и не крупнее 60px за день; пустая ширина — DAY_PX", () => {
    expect(fitWeeks(10)).toBe(3);
    expect(fitWeeks(100_000)).toBe(60);
    expect(fitWeeks(0)).toBe(26);
    expect(fitWeeks(-5)).toBe(26);
  });

  it("clampDayPx удерживает ручной зум в границах", () => {
    expect(clampDayPx(26 * 1.25)).toBe(32.5);
    expect(clampDayPx(1000)).toBe(60);
    expect(clampDayPx(0.1)).toBe(3);
  });
});

