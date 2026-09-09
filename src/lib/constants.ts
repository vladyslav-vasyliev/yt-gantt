// Константы и чистые помощники без побочных эффектов.

export const SIZE_MAP: Record<string, number> = { "XS": 3, "S": 5, "M": 10, "L": 20, "XL": 40, "XXL": 80 };
export const COLORS: readonly string[] = ["#2f6fdb","#1f9d61","#b07d1a","#7d4bc4","#0e8fa3","#c85a3a","#5c8f1f","#b83d80"];
export const MAX_ISSUES = 500;      // предохранитель дерева
export const FETCH_CONCURRENCY = 5; // параллельных запросов

export const DAY_PX = 26, ROW_H = 34, TOP = 46;

// --- масштаб диаграммы ---------------------------------------------------------
// по умолчанию на экран помещается 8 недель; дальше — кнопками «−»/«+»
export const WEEKS_ON_SCREEN = 8;
export const DAY_PX_MIN = 3, DAY_PX_MAX = 60;
export const ZOOM_STEP = 1.25;

// px за день, чтобы weeks недель поместились в availablePx (с ограничениями)
export function fitWeeks(availablePx: number, weeks: number = WEEKS_ON_SCREEN,
                         min: number = DAY_PX_MIN, max: number = DAY_PX_MAX): number {
  if (!(availablePx > 0)) return DAY_PX;
  return Math.min(max, Math.max(min, availablePx / (weeks * 7)));
}

export const clampDayPx = (v: number): number => Math.min(DAY_PX_MAX, Math.max(DAY_PX_MIN, v));

// загруженный из YouTrack issue (после обогащения в preload)
export interface IssueLink {
  dir: string;
  name: string;
  stt: string; // linkType.sourceToTarget
  tts: string; // linkType.targetToSource
  ids: string[];
}

// событие истории изменений (нормализованное, сохраняется при загрузке тикета):
// ts — момент события, field — имя поля, added/removed — значения поля
export interface HistoryEvent {
  ts: Date | null;
  field: string;
  added: string[];
  removed: string[];
}

export interface Issue {
  id: string;
  summary: string;
  sizeRaw: string | null;
  links: IssueLink[];
  resolved: boolean;
  resolvedAt: Date | null;
  _fieldValues: string[];
  /** значения всех кастомных полей: { имяПоля → строка } — для лямбд расчёта */
  _customFields?: Record<string, string>;
  _statuses?: Set<string>;
  /** полные списки возможных значений из бандлов полей проекта */
  _bundleValues?: Record<string, string[]>;
  /** история изменений (сырые события) — загружается вместе с тикетом */
  _history?: HistoryEvent[];
  // обогащение при обходе дерева / расписании
  depth?: number;
  _kids?: string[];
  days?: number;
  start?: Date;
  end?: Date;
  /** бар оценки (план по Size) — идёт параллельно факту и может с ним расходиться */
  estStart?: Date;
  estEnd?: Date;
  actualStart?: Date | null;
  actualEnd?: Date | null;
}

export interface LoadContext {
  base: string;
  token: string;
  sizeField: string;
  // каждая сетевая ошибка уходит сюда (в App — прямиком в Toast)
  onNetworkError?: (message: string) => void;
}

export interface AppSettings {
  baseUrl: string;
  token: string;
  ids: string;
  sizeField: string;
  stateField: string;
  startStatus: string;
  project: string;
  linkType: string;
  skipWeekends: boolean;
  startToday: boolean;
}

export const norm = (s: string | null | undefined): string => (s || "").trim().toLowerCase();

export interface SelectItem { value: string; label: string }

// элементы селекта из загруженных значений; текущее значение всегда присутствует:
// если его нет в списке — добавляется с пометкой « *» в label, но с ЧИСТЫМ value,
// иначе ComboBox не сматует value и покажет пустое поле
export function withCurrent(list: string[], current: string, fallback: string): SelectItem[] {
  const values = list && list.length ? [...list] : [fallback];
  const items: SelectItem[] = values.map((v) => ({ value: v, label: v }));
  if (current && !values.includes(current)) items.push({ value: current, label: current + " *" });
  return items.sort((a, b) => a.label.localeCompare(b.label, "ru"));
}

export function issueUrl(base: string, id: string): string {
  return base.replace(/\/+$/, "") + "/issue/" + encodeURIComponent(id);
}

export function parseIds(raw: string): string[] {
  return [...new Set(raw.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];
}

// «101, infra-5, PROJ-9» + префикс INFRA → INFRA-101, INFRA-5, INFRA-9
export function applyProjectPrefix(raw: string, projectPrefix: string): string {
  if (!projectPrefix) return raw;
  return raw.replace(
    /(?<![A-Za-z0-9])(?:([A-Za-z][A-Za-z0-9]*)-)?(\d+)(?![\d-])/g,
    (m: string, p?: string, n?: string) => {
      // совпадающий префикс нормализуем к каноническому регистру
      if (p) return `${projectPrefix}-${n}`;
      return `${projectPrefix}-${n}`;
    }
  );
}

export function fmtDate(d: Date): string {
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function isWeekend(d: Date): boolean {
  const w = d.getDay();
  return w === 0 || w === 6;
}

export function nextWorkday(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  while (isWeekend(x)) x.setDate(x.getDate() + 1);
  return x;
}

// --- фактическая длительность -------------------------------------------------

export interface FactSpan { start: Date; end: Date; open: boolean }

// фактический промежуток задачи: от перехода в статус начала до resolvedAt;
// незавершённые — до сегодняшнего дня (open=true, «в работе»);
// resolved без даты завершения — точка в старте; null — факта нет
export function factSpan(it: Issue, today?: Date): FactSpan | null {
  if (!it.actualStart) return null;
  const start = new Date(it.actualStart); start.setHours(0, 0, 0, 0);
  let end: Date;
  if (it.actualEnd) end = new Date(it.actualEnd);
  else if (it.resolved) end = new Date(start);
  else end = new Date(today ?? new Date());
  end.setHours(0, 0, 0, 0);
  if (end < start) end = new Date(start);
  return { start, end, open: !it.actualEnd && !it.resolved };
}

// календарные дни включительно (оба конца)
export function calendarDaysBetween(s: Date, e: Date): number {
  const a = new Date(s); a.setHours(0, 0, 0, 0);
  const b = new Date(e); b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
}

// рабочие дни (пн–пт) включительно
export function workdaysBetween(s: Date, e: Date): number {
  const a = new Date(s); a.setHours(0, 0, 0, 0);
  const b = new Date(e); b.setHours(0, 0, 0, 0);
  let n = 0;
  for (const x = new Date(a); x <= b; x.setDate(x.getDate() + 1))
    if (!isWeekend(x)) n++;
  return n;
}

// --- ширина колонки задач диаграммы (сохраняется в localStorage) ---------------

export const LABEL_W_DEFAULT = 380;
export const LABEL_W_MIN = 220, LABEL_W_MAX = 800;

export function loadLabelW(): number {
  try {
    const v = Number(localStorage.getItem("yt_labelw"));
    return Number.isFinite(v) && v >= LABEL_W_MIN && v <= LABEL_W_MAX ? Math.round(v) : LABEL_W_DEFAULT;
  } catch { return LABEL_W_DEFAULT; }
}

export function saveLabelW(v: number): void {
  try { localStorage.setItem("yt_labelw", String(Math.round(v))); } catch { /* приватный режим — не критично */ }
}

// --- persistence --------------------------------------------------------------

export function loadSettings(): AppSettings {
  const get = (k: string, d: string): string => {
    try { return localStorage.getItem(k) ?? d; } catch { return d; }
  };
  return {
    baseUrl: get("yt_url", "https://youtrack.instance"),
    token: get("yt_token", ""),
    ids: get("yt_ids", ""),
    sizeField: get("yt_sizefield", "Size"),
    stateField: get("yt_statefield", "State"),
    startStatus: get("yt_startstatus", "In Progress"),
    project: get("yt_project", ""),
    linkType: get("yt_linktype", "parent for"),
    skipWeekends: get("yt_skipweekends", "1") === "1",
    startToday: get("yt_starttoday", "1") === "1",
  };
}

export function saveSettings(s: AppSettings): void {
  try {
    localStorage.setItem("yt_url", s.baseUrl.trim());
    localStorage.setItem("yt_token", s.token.trim());
    localStorage.setItem("yt_ids", s.ids.trim());
    localStorage.setItem("yt_sizefield", s.sizeField.trim());
    localStorage.setItem("yt_statefield", s.stateField.trim());
    localStorage.setItem("yt_startstatus", s.startStatus.trim());
    localStorage.setItem("yt_project", s.project.trim().toUpperCase());
    localStorage.setItem("yt_linktype", s.linkType);
    localStorage.setItem("yt_skipweekends", s.skipWeekends ? "1" : "0");
    localStorage.setItem("yt_starttoday", s.startToday ? "1" : "0");
  } catch { /* приватный режим — не критично */ }
}

