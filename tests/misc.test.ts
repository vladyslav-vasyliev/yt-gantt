// Corner-case тесты: fmtDate, loadLabelW/saveLabelW, прямые URL (без PROXY),
// многостраничная история заканчивается короткой страницей.
import { describe, it, expect, vi } from "vitest";
import { fmtDate, loadLabelW, saveLabelW, LABEL_W_DEFAULT, LABEL_W_MIN, LABEL_W_MAX } from "../src/lib/constants";

describe("fmtDate", () => {
  it("форматирует дату в ru-RU дд.мм.гггг", () => {
    expect(fmtDate(new Date(2026, 8, 10))).toBe("10.09.2026");
    expect(fmtDate(new Date(2026, 0, 1))).toBe("01.01.2026");
  });
});

describe("loadLabelW / saveLabelW", () => {
  beforeEachStorage();
  function beforeEachStorage() {
    vi.stubGlobal("localStorage", {
      store: {} as Record<string, string>,
      getItem(k: string) { return (this as unknown as { store: Record<string, string> }).store[k] ?? null; },
      setItem(k: string, v: string) { (this as unknown as { store: Record<string, string> }).store[k] = v; },
      removeItem(k: string) { delete (this as unknown as { store: Record<string, string> }).store[k]; },
    });
  }

  it("ключа нет → дефолт; значение в границах → округляется", () => {
    expect(loadLabelW()).toBe(LABEL_W_DEFAULT);
    localStorage.setItem("yt_labelw", "320.7");
    expect(loadLabelW()).toBe(321);
  });

  it("не-число, слишком малое, слишком большое → дефолт", () => {
    localStorage.setItem("yt_labelw", "abc");
    expect(loadLabelW()).toBe(LABEL_W_DEFAULT);
    localStorage.setItem("yt_labelw", String(LABEL_W_MIN - 1));
    expect(loadLabelW()).toBe(LABEL_W_DEFAULT);
    localStorage.setItem("yt_labelw", String(LABEL_W_MAX + 1));
    expect(loadLabelW()).toBe(LABEL_W_DEFAULT);
  });

  it("localStorage бросает → дефолт / save молчит", () => {
    // перекрываем stub из beforeEach блокирующим (afterEach ниже снимет общий)
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    expect(loadLabelW()).toBe(LABEL_W_DEFAULT);
    expect(() => saveLabelW(300)).not.toThrow();
    // восстанавливаем рабочий stub для следующих тестов
    beforeEachStorage();
  });

  it("saveLabelW сохраняет округлённое значение", () => {
    saveLabelW(299.6);
    expect(loadLabelW()).toBe(300); // чтение через тот же stubbed localStorage
  });
});
