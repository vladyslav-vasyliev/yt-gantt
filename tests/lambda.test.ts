// Unit-тесты пользовательских лямбд расчёта: компиляция, безопасные вызовы,
// дефолты, persistence.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import {
  compileSizeLambda, compileStartLambda, toLambdaIssue,
  callSizeLambda, callStartLambda,
  DEFAULT_SIZE_LAMBDA, DEFAULT_START_LAMBDA,
  loadSizeLambda, loadStartLambda, saveSizeLambda, saveStartLambda,
  resetSizeLambda, resetStartLambda,
} from "../src/lib/lambda";
import type { Issue } from "../src/lib/constants";

const mkIssue = (patch: Partial<Issue> = {}): Issue => ({
  id: "INFRA-1", summary: "s", sizeRaw: "M", links: [],
  resolved: false, resolvedAt: null, _fieldValues: [], ...patch,
});

describe("компиляция лямбд", () => {
  it("валидная лямбда компилируется в функцию", () => {
    const r = compileSizeLambda("(i, a) => 5");
    expect(r.error).toBeNull();
    expect(r.fn!("x" as never, [])).toBe(5);
  });

  it("пустая строка и только пробелы — ошибка «пустая лямбда»", () => {
    expect(compileSizeLambda("").error).toBe("Поле «Размер»: пустая лямбда");
    expect(compileStartLambda("   \n  ").error).toBe("Поле «Начало работ»: пустая лямбда");
  });

  it("синтаксическая ошибка — понятное сообщение с именем поля", () => {
    const r = compileSizeLambda("(i) => {");
    expect(r.fn).toBeNull();
    expect(r.error).toContain("Поле «Размер»");
    const r2 = compileStartLambda(")))");
    expect(r2.error).toContain("Поле «Начало работ»");
  });

  it("выражение не функция — ошибка, не падение", () => {
    expect(compileSizeLambda("42").error).toBe("Поле «Размер»: выражение не функция");
    expect(compileStartLambda("'hi'").error).toBe("Поле «Начало работ»: выражение не функция");
  });
});

describe("toLambdaIssue", () => {
  it("отдаёт данные тикета; _customFields отсутствует → пустой словарь; links null → []", () => {
    const it = mkIssue({ _customFields: { Size: "L" }, links: undefined as never });
    const v = toLambdaIssue(it);
    expect(v).toMatchObject({ id: "INFRA-1", sizeRaw: "M", customFields: { Size: "L" } });
    expect(v.links).toEqual([]);
    const v2 = toLambdaIssue(mkIssue());
    expect(v2.customFields).toEqual({});
  });
});

describe("callSizeLambda", () => {
  it("число — округляется; 0 допустим; отрицательное — ошибка и дефолт 10", () => {
    const problems: string[] = [];
    expect(callSizeLambda(() => 7.6, mkIssue(), problems)).toBe(8);
    expect(callSizeLambda(() => 0, mkIssue(), problems)).toBe(0);
    expect(problems).toHaveLength(0);
    expect(callSizeLambda(() => -3, mkIssue(), problems)).toBe(10);
    expect(problems[0]).toContain("вернула -3");
    expect(problems[0]).toContain("принят размер 10 дн.");
  });

  it("не-число, Infinity/NaN — ошибка и дефолт", () => {
    const problems: string[] = [];
    expect(callSizeLambda(() => "10" as never, mkIssue(), problems)).toBe(10);
    expect(callSizeLambda(() => Infinity, mkIssue(), problems)).toBe(10);
    expect(callSizeLambda(() => NaN, mkIssue(), problems)).toBe(10);
    expect(problems).toHaveLength(3);
  });

  it("бросок исключения — problems + дефолт; не-Error — тоже", () => {
    const problems: string[] = [];
    expect(callSizeLambda(() => { throw new Error("boom"); }, mkIssue(), problems)).toBe(10);
    expect(problems[0]).toContain("boom");
    expect(callSizeLambda(() => { throw "строка"; }, mkIssue(), problems)).toBe(10);
    expect(problems[1]).toContain("упала");
  });

  it("кастомный label попадает в текст проблемы", () => {
    const problems: string[] = [];
    callSizeLambda(() => { throw new Error("x"); }, mkIssue(), problems, "Размер");
    expect(problems[0]).toContain("«Размер»");
  });

  it("дефолтная лямбда Size: известные значения, неизвестное и пустое → 10", () => {
    const fn = compileSizeLambda(DEFAULT_SIZE_LAMBDA).fn!;
    const mk = (cf: Record<string, string>, sizeRaw: string | null) => mkIssue({ _customFields: cf, sizeRaw });
    expect(fn(toLambdaIssue(mk({ Size: "L" }, "L")), [])).toBe(20);
    expect(fn(toLambdaIssue(mk({ Size: "xs" }, "xs")), [])).toBe(3); // регистр не важен
    expect(fn(toLambdaIssue(mk({}, null)), [])).toBe(10);            // поле пустое
    expect(fn(toLambdaIssue(mk({ Size: "" }, "Mega")), [])).toBe(10); // неизвестное значение
  });

  it("история передаётся вторым аргументом", () => {
    const it = mkIssue({ _history: [{ ts: new Date(0), field: "State", added: ["Doing"], removed: [] }] });
    const seen: unknown[] = [];
    callSizeLambda((_i, a) => { seen.push(a); return 1; }, it, []);
    expect(seen[0]).toBe(it._history);
  });
});

describe("callStartLambda", () => {
  it("Date — возвращается как есть; строка/число — конвертируются", () => {
    const d = new Date("2026-01-05");
    expect(callStartLambda(() => d, mkIssue(), [])).toBe(d);
    const parsed = callStartLambda(() => "2026-01-05T00:00:00Z" as never, mkIssue(), []);
    expect(parsed!.getTime()).toBe(Date.parse("2026-01-05T00:00:00Z"));
  });

  it("null/undefined — факт нет, без проблем", () => {
    const problems: string[] = [];
    expect(callStartLambda(() => null, mkIssue(), problems)).toBeNull();
    expect(callStartLambda(() => undefined as never, mkIssue(), problems)).toBeNull();
    expect(problems).toHaveLength(0);
  });

  it("Invalid Date — проблема и null", () => {
    const problems: string[] = [];
    expect(callStartLambda(() => new Date("не дата"), mkIssue(), problems)).toBeNull();
    expect(problems[0]).toContain("вместо даты");
  });

  it("бросок исключения — проблема и null", () => {
    const problems: string[] = [];
    expect(callStartLambda(() => { throw new Error("oops"); }, mkIssue(), problems)).toBeNull();
    expect(problems[0]).toContain("oops");
    expect(problems[0]).toContain("дата начала не определена");
  });

  it("дефолтная лямбда: самая ранняя Doing; регистр/чужие статусы игнорируются; без ts — мимо", () => {
    const fn = compileStartLambda(DEFAULT_START_LAMBDA).fn!;
    const acts = [
      { ts: new Date("2026-01-10"), field: "State", added: ["Doing"], removed: [] },
      { ts: new Date("2026-01-05"), field: "State", added: ["DOING"], removed: [] }, // раньше
      { ts: new Date("2026-01-01"), field: "State", added: ["Open"], removed: [] },
    ];
    expect(fn(toLambdaIssue(mkIssue()), acts)!.getTime()).toBe(Date.parse("2026-01-05"));
    // ts null — событие пропускается
    const noTs = [{ ts: null, field: "State", added: ["Doing"], removed: [] }];
    expect(fn(toLambdaIssue(mkIssue()), noTs as never)).toBeNull();
  });
});

describe("persistence лямбд", () => {
  const realLS = globalThis.localStorage;

  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      store: {} as Record<string, string>,
      getItem(k: string) { return (this as unknown as { store: Record<string, string> }).store[k] ?? null; },
      setItem(k: string, v: string) { (this as unknown as { store: Record<string, string> }).store[k] = v; },
      removeItem(k: string) { delete (this as unknown as { store: Record<string, string> }).store[k]; },
    });
  });

  it("save → load возвращает сохранённое; load без сохранения — дефолты", () => {
    expect(loadSizeLambda()).toBe(DEFAULT_SIZE_LAMBDA);
    expect(loadStartLambda()).toBe(DEFAULT_START_LAMBDA);
    saveSizeLambda("(i) => 1");
    saveStartLambda("(i) => null");
    expect(loadSizeLambda()).toBe("(i) => 1");
    expect(loadStartLambda()).toBe("(i) => null");
  });

  it("reset стирает ключ и возвращает дефолт", () => {
    saveSizeLambda("(i) => 1");
    saveStartLambda("(i) => 2");
    expect(resetSizeLambda()).toBe(DEFAULT_SIZE_LAMBDA);
    expect(resetStartLambda()).toBe(DEFAULT_START_LAMBDA);
    expect(loadSizeLambda()).toBe(DEFAULT_SIZE_LAMBDA);
    expect(loadStartLambda()).toBe(DEFAULT_START_LAMBDA);
  });

  it("localStorage блокируется — load/save/reset не падают, load отдаёт дефолт", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    });
    expect(loadSizeLambda()).toBe(DEFAULT_SIZE_LAMBDA);
    expect(loadStartLambda()).toBe(DEFAULT_START_LAMBDA);
    expect(() => saveSizeLambda("x")).not.toThrow();
    expect(() => saveStartLambda("x")).not.toThrow();
    expect(resetSizeLambda()).toBe(DEFAULT_SIZE_LAMBDA);
    expect(resetStartLambda()).toBe(DEFAULT_START_LAMBDA);
    vi.unstubAllGlobals();
  });

  it("getItem вернул null (ключа нет) — дефолт", () => {
    expect(loadSizeLambda()).toBe(DEFAULT_SIZE_LAMBDA);
  });

  afterAll(() => vi.unstubAllGlobals());
});
