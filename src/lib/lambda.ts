// Пользовательские лямбды расчёта: размер в днях и дата начала работ.
// Лямбда задаётся строкой в настройках (таб «Расчёт»), компилируется через
// new Function и вызывается для каждой задачи при построении диаграммы.
//
// Сигнатуры:
//   (issue, activities) => number        — размер в днях
//   (issue, activities) => Date | null   — дата начала работ (null — факта нет)
//
// issue: { id, summary, sizeRaw, resolved, resolvedAt, links, customFields }
// activities: [{ ts, field, added[], removed[] }] — история изменений полей
//
// Ошибки компиляции/выполнения не роняют построение: лямбда помечается
// сломанной и используется дефолтная, текст ошибки уходит в предупреждения.
import { type Issue, type HistoryEvent } from "./constants";

// Объект issue, передаваемый в лямбду: данные тикета без служебных полей.
// customFields: { имяПоля → значение } — удобнее, чем сырой customFields API.
export interface LambdaIssue {
  id: string;
  summary: string;
  sizeRaw: string | null;
  resolved: boolean;
  resolvedAt: Date | null;
  links: { dir: string; name: string; stt: string; tts: string; ids: string[] }[];
  customFields: Record<string, string>;
}

// activity истории: { ts, field, added[], removed[] }
export type LambdaActivity = HistoryEvent;

export type SizeFn = (issue: LambdaIssue, activities: LambdaActivity[]) => number;
export type StartFn = (issue: LambdaIssue, activities: LambdaActivity[]) => Date | null;

// --- лямбда по умолчанию: Size → дни (XS…XXL, неизвестное значение → M) ------
export const SIZE_MAP: Record<string, number> = { "XS": 3, "S": 5, "M": 10, "L": 20, "XL": 40, "XXL": 80 };

export const DEFAULT_SIZE_LAMBDA = `(issue, activities) => {
  const sizeMap = { "XS": 3, "S": 5, "M": 10, "L": 20, "XL": 40, "XXL": 80 };
  const raw = (issue.customFields["Size"] || issue.sizeRaw || "M").toUpperCase();
  return sizeMap[raw] != null ? sizeMap[raw] : sizeMap["M"];
}`;

// --- лямбда по умолчанию: дата перехода в статус «Doing» ---------------------
export const DEFAULT_START_LAMBDA = `(issue, activities) => {
  const wanted = "doing"; // нормализованное имя статуса начала
  let found = null;
  for (const a of activities) {
    for (const added of a.added) {
      if (added.toLowerCase() === wanted && a.ts && (!found || a.ts < found)) found = a.ts;
    }
  }
  return found;
}`;

export interface LambdaResult<T> {
  fn: T | null;
  error: string | null;
}

// компиляция строки в функцию: один аргумент «issue, activities»
function compile<T>(code: string, what: string): LambdaResult<T> {
  const trimmed = (code || "").trim();
  if (!trimmed) return { fn: null, error: `${what}: пустая лямбда` };
  try {
    const fn = new Function(`"use strict"; return (${trimmed});`)() as T;
    if (typeof fn !== "function") return { fn: null, error: `${what}: выражение не функция` };
    return { fn, error: null };
  } catch (e) {
    return { fn: null, error: `${what}: ${e instanceof Error ? e.message : "ошибка компиляции"}` };
  }
}

export function compileSizeLambda(code: string): LambdaResult<SizeFn> {
  return compile<SizeFn>(code, "Поле «Размер»");
}

export function compileStartLambda(code: string): LambdaResult<StartFn> {
  return compile<StartFn>(code, "Поле «Начало работ»");
}

// вью-модель issue для лямбд: данные тикета + customFields как словарь
export function toLambdaIssue(it: Issue): LambdaIssue {
  return {
    id: it.id,
    summary: it.summary,
    sizeRaw: it.sizeRaw,
    resolved: it.resolved,
    resolvedAt: it.resolvedAt,
    links: it.links || [],
    customFields: it._customFields || {},
  };
}

// безопасный вызов лямбды размера: ошибка → дефолт M (10 дней) + проблема
export function callSizeLambda(
  fn: SizeFn, it: Issue, problems: string[], sizeFieldLabel = "Размер",
): number {
  const arg = toLambdaIssue(it);
  try {
    const days = fn(arg, it._history || []);
    if (typeof days !== "number" || !Number.isFinite(days) || days < 0)
      throw new Error(`вернула ${String(days)} вместо числа дней`);
    return Math.round(days);
  } catch (e) {
    const msg = `${it.id}: лямбда «${sizeFieldLabel}» ${e instanceof Error ? e.message : "упала"} — принят размер 10 дн.`;
    problems.push(msg);
    return 10;
  }
}

// безопасный вызов лямбды старта: ошибка → null (факт не определён) + проблема
export function callStartLambda(fn: StartFn, it: Issue, problems: string[]): Date | null {
  const arg = toLambdaIssue(it);
  try {
    const d = fn(arg, it._history || []);
    if (d == null) return null;
    const date = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(date.getTime())) throw new Error(`вернула ${String(d)} вместо даты`);
    return date;
  } catch (e) {
    const msg = `${it.id}: лямбда «Начало работ» ${e instanceof Error ? e.message : "упала"} — дата начала не определена`;
    problems.push(msg);
    return null;
  }
}

// --- persistence -------------------------------------------------------------

const KEY_SIZE = "yt_size_lambda";
const KEY_START = "yt_start_lambda";

export function loadSizeLambda(): string {
  try { return localStorage.getItem(KEY_SIZE) ?? DEFAULT_SIZE_LAMBDA; }
  catch { return DEFAULT_SIZE_LAMBDA; }
}

export function loadStartLambda(): string {
  try { return localStorage.getItem(KEY_START) ?? DEFAULT_START_LAMBDA; }
  catch { return DEFAULT_START_LAMBDA; }
}

export function saveSizeLambda(code: string): void {
  try { localStorage.setItem(KEY_SIZE, code); } catch { /* приватный режим */ }
}

export function saveStartLambda(code: string): void {
  try { localStorage.setItem(KEY_START, code); } catch { /* приватный режим */ }
}

export function resetSizeLambda(): string {
  try { localStorage.removeItem(KEY_SIZE); } catch { /* приватный режим */ }
  return DEFAULT_SIZE_LAMBDA;
}

export function resetStartLambda(): string {
  try { localStorage.removeItem(KEY_START); } catch { /* приватный режим */ }
  return DEFAULT_START_LAMBDA;
}
