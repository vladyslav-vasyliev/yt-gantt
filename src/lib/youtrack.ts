// YouTrack REST API: загрузка issue + истории, метаданные из данных тикетов.
import { FETCH_CONCURRENCY, norm, type HistoryEvent, type Issue, type LoadContext } from "./constants";

// Через http(s) запросы идут через локальный прокси сервера (/yt/...?__base=...),
// чтобы обойти CORS. При открытии через file:// — прямой запрос.
export const PROXY: boolean =
  typeof location !== "undefined" &&
  (location.protocol === "http:" || location.protocol === "https:");

// кеш загруженных issue: key = idReadable (upper) → issue
export const cache = new Map<string, Issue>();

interface RawCustomField { name?: string; value?: { name?: string; localizedName?: string } | string | null }
interface RawLinkType { name?: string; sourceToTarget?: string; targetToSource?: string }
interface RawIssue {
  idReadable?: string;
  summary?: string;
  resolved?: string | null;
  customFields?: RawCustomField[];
  links?: { direction?: string; linkType?: RawLinkType; issues?: { idReadable?: string }[] }[];
}

// значение кастомного поля API: строка | {name, localizedName} | массив (MultiEnum) —
// у мультиполей берём первый элемент; localizedName бывает null (реальный API)
function parseFieldValue(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (first == null) return null;
  if (typeof first === "string") return first;
  const o = first as { name?: string | null; localizedName?: string | null };
  return o.name || o.localizedName || null;
}

export async function fetchIssue(
  base: string, token: string, id: string, sizeField: string
): Promise<Issue> {
  const fields =
    "idReadable,summary,resolved," +
    "customFields(name,value(name,localizedName)," +
    "projectCustomField(field(name),bundle(values(name,localizedName))))," +
    "links(linkType(name,sourceToTarget,targetToSource),direction,issues(idReadable))";
  const qs = "fields=" + encodeURIComponent(fields);
  const url = PROXY
    ? `/yt/api/issues/${encodeURIComponent(id)}?${qs}&__base=${encodeURIComponent(base)}`
    : `${base}/api/issues/${encodeURIComponent(id)}?${qs}`;
  const resp = await fetch(url, {
    headers: { "Accept": "application/json", "Authorization": "Bearer " + token.trim() },
  });
  if (resp.status === 404) throw Object.assign(new Error(`"${id}" не найден`), { code: 404 });
  if (resp.status === 401 || resp.status === 403)
    throw Object.assign(new Error("401/403 — проверьте токен и права"), { code: resp.status });
  if (!resp.ok) throw Object.assign(new Error(`HTTP ${resp.status} для ${id}`), { code: resp.status });
  const data: RawIssue = await resp.json();

  const cf = (data.customFields || []).find(
    (f) => f.name && f.name.toLowerCase() === sizeField.toLowerCase());
  const sizeRaw = cf ? parseFieldValue(cf.value) : null;

  // id приводим к верхнему регистру: YouTrack отдаёт idReadable в любом регистре
  // (встречается «bi_proj-761»), а _kids/кеш/парсер идентификаторов — в верхнем
  const issueId = (data.idReadable || id).toUpperCase();

  const links = (data.links || []).map((L) => ({
    dir: L.direction || "",
    name: (L.linkType && L.linkType.name) || "",
    stt: (L.linkType && L.linkType.sourceToTarget) || "",
    tts: (L.linkType && L.linkType.targetToSource) || "",
    ids: (L.issues || []).map((x) => (x.idReadable || "").toUpperCase()).filter(Boolean),
  }));

  const _fieldValues = (data.customFields || []).map((f) => f?.name).filter(Boolean) as string[];

  // значения всех кастомных полей одним словарём — для пользовательских лямбд
  const _customFields: Record<string, string> = {};
  for (const f of data.customFields || []) {
    if (f?.name) _customFields[f.name] = parseFieldValue(f.value) ?? "";
  }

  // полные списки возможных значений из бандлов полей проекта:
  // { fieldName → [значения] } — например State → все статусы воркфлоу.
  // У полей без бандла (SimpleProjectCustomField) значений нет — пропускаем.
  const _bundleValues: Record<string, string[]> = {};
  for (const f of data.customFields || []) {
    const fname = f?.name;
    const pcf = (f as unknown as { projectCustomField?: { bundle?: { values?: { name?: string; localizedName?: string | null }[] } } })?.projectCustomField;
    const vals = (pcf?.bundle?.values || []).map((v) => v?.name).filter(Boolean) as string[];
    if (fname && vals.length) _bundleValues[fname] = vals;
  }

  return {
    id: issueId, summary: data.summary || "", sizeRaw, links,
    resolved: data.resolved != null,
    resolvedAt: data.resolved ? new Date(data.resolved) : null,
    _fieldValues, _customFields, _bundleValues,
  };
}

type RawHistoryValue = { name?: string };
interface RawHistoryEvent {
  timestamp?: number | string;
  field?: { name?: string; customField?: { name?: string } } | null;
  added?: RawHistoryValue | RawHistoryValue[] | null;
  removed?: RawHistoryValue | RawHistoryValue[] | null;
}

// fields describes the response, not a filter by a custom field's name.
// Keep all custom-field events so UI field changes do not require another load.
async function fetchHistoryEvents(base: string, token: string, id: string): Promise<{ events: RawHistoryEvent[] | null; error: string | null }> {
  const fields = "timestamp,field(name,customField(name)),added(name),removed(name)";
  const headers = { "Accept": "application/json", "Authorization": "Bearer " + token.trim() };
  const events: RawHistoryEvent[] = [];
  const pageSize = 100;
  for (let skip = 0; ; skip += pageSize) {
    const qs = new URLSearchParams({
      fields, categories: "CustomFieldCategory", reverse: "false",
      $top: String(pageSize), $skip: String(skip),
    });
    const path = `/api/issues/${encodeURIComponent(id)}/activities?${qs}`;
    const url = PROXY
      ? `/yt${path}&__base=${encodeURIComponent(base)}`
      : base + path;
    try {
      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        const reason = resp.status === 401 || resp.status === 403
          ? `доступ запрещён (HTTP ${resp.status}) — проверьте права токена`
          : `HTTP ${resp.status}`;
        return { events: null, error: reason };
      }
      const page: RawHistoryEvent[] = await resp.json();
      if (!Array.isArray(page)) throw new Error("Некорректный ответ API истории: ожидался массив");
      events.push(...page);
      if (page.length < pageSize) return { events, error: null };
    } catch (e) {
      return { events: null, error: e instanceof Error ? e.message : "сетевая ошибка" };
    }
  }
}

// нормализованная история тикета: скачивается один раз при загрузке,
// дата статуса начала и списки статусов вычисляются позже (computeActualStart)
export async function fetchIssueHistory(base: string, token: string, id: string): Promise<{ history: HistoryEvent[]; error: string | null }> {
  const { events, error } = await fetchHistoryEvents(base, token, id);
  const names = (value: RawHistoryEvent["added"]): string[] =>
    (Array.isArray(value) ? value : value ? [value] : []).map((a) => a.name || "").filter(Boolean);
  return {
    history: (events || []).map((e) => ({
      ts: e.timestamp != null ? new Date(e.timestamp) : null,
      field: e.field?.customField?.name || e.field?.name || "",
      added: names(e.added),
      removed: names(e.removed),
    })),
    error,
  };
}

// дата перехода в статус начала работы — из истории, сохранённой на тикете.
// Попутно собирает значения поля статуса для подсказок селекта.
export function computeActualStart(it: Issue, stateField: string, startStatus: string): Date | null {
  const want = norm(stateField), wantStatus = norm(startStatus);
  const st = it._statuses = new Set<string>();
  let found: Date | null = null;
  for (const e of it._history || []) {
    if (!want || norm(e.field) !== want) continue;
    for (const a of e.added.concat(e.removed)) st.add(a);
    for (const a of e.added) {
      if (norm(a) === wantStatus && e.ts && (!found || e.ts < found)) found = e.ts;
    }
  }
  return found;
}

// батч-загрузка отсутствующих в кеше (вместе с историей изменений), с прогрессом
export async function fetchBatch(
  ids: string[],
  ctx: LoadContext,
  problems: string[],
  progress?: (loaded: number, left: number) => void,
): Promise<void> {
  // каждая сетевая ошибка — и в problems, и в Toast-канал
  const report = (msg: string): void => { problems.push(msg); ctx.onNetworkError?.(msg); };
  const missing = [...new Set(ids)].filter((id) => !cache.has(id));
  for (let i = 0; i < missing.length; i += FETCH_CONCURRENCY) {
    const chunk = missing.slice(i, i + FETCH_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((id) => fetchIssue(ctx.base, ctx.token, id, ctx.sizeField)));
    // истории качаем параллельно внутри чанка — иначе загрузка длинного дерева
    // растягивается в N раз (запрос ~150мс × 5 тикетов последовательно)
    const histories = await Promise.allSettled(
      settled.map((r) => (r.status === "fulfilled"
        ? fetchIssueHistory(ctx.base, ctx.token, r.value.id)
        : Promise.resolve(null))));
    for (let j = 0; j < chunk.length; j++) {
      const r = settled[j];
      if (r.status === "fulfilled") {
        const it = r.value;
        cache.set(it.id.toUpperCase(), it);
        // история нужна для даты статуса начала — скачаем сразу при загрузке,
        // чтобы «Построить» мог пересчитывать факт без походов в сеть
        const h = histories[j];
        if (h && h.status === "fulfilled" && h.value) {
          it._history = h.value.history;
          if (h.value.error) report(`${it.id}: история изменений недоступна (${h.value.error})`);
        } else {
          it._history = [];
          const reason = h && h.status === "rejected" && h.reason instanceof Error ? h.reason.message : "сетевая ошибка";
          report(`${it.id}: история изменений недоступна (${reason})`);
        }
      } else {
        const e = r.reason as Error & { code?: number };
        const msg = `${chunk[j]}: ${e?.message ? e.message : "ошибка загрузки"}`;
        if (e && (e.code === 401 || e.code === 403)) {
          problems.push(msg);
          throw e; // без валидного токена продолжать бессмысленно
        }
        report(msg);
      }
    }
    if (progress) progress(cache.size, missing.length - (i + chunk.length));
  }
}

// тикеты без истории изменений: дата статуса начала для них не определима
export function idsWithoutHistory(issues: Issue[]): string[] {
  return issues.filter((it) => !(it._history || []).length).map((it) => it.id);
}

export interface IssueMeta { fieldNames: string[]; statuses: string[] }

// метаданные для селектов из данных, доступных обычному токену:
//   имена полей — из customFields тикетов;
//   статусы — полный список возможных значений из бандла поля «Поле статуса»
//   (projectCustomField.bundle.values), дополненный значениями из истории —
//   так в списке «Статус начала работы» весь воркфлоу проекта, а не только
//   посещённые статусами тикетов значения. Бандлы других полей (Size и т.д.)
//   в список статусов не попадают.
export function collectMetaFromIssues(stateField?: string): { fieldNames: string[]; statuses: string[] } {
  const fieldNames = new Set<string>();
  const statuses = new Set<string>();
  const want = norm(stateField) || "state"; // дефолт-поле статуса
  for (const it of cache.values()) {
    if (it._fieldValues) for (const fn of it._fieldValues) fieldNames.add(fn);
    if (it._bundleValues) {
      for (const [fname, vals] of Object.entries(it._bundleValues)) {
        if (norm(fname) === want) vals.forEach((v) => statuses.add(v));
      }
    }
    for (const e of it._history || []) {
      if (norm(e.field) !== want) continue;
      for (const value of e.added.concat(e.removed)) statuses.add(value);
    }
  }
  return { fieldNames: [...fieldNames], statuses: [...statuses] };
}

// типы связей из кеша — для селекта «Тип связи дочерних».
// Сортировка байтами (не localeCompare): чтобы регистр не смешивал группы,
// а порядок был детерминированным на любых локалях.
export function collectLinkTypes(): string[] {
  const names = new Set<string>();
  for (const it of cache.values())
    for (const L of it.links || [])
      [L.name, L.stt, L.tts].forEach((n) => { if (n?.trim()) names.add(n.trim()); });
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
