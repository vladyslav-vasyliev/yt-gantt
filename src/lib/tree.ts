// Дерево связей и модель расписания «родитель-обёртка».
import { isWeekend, nextWorkday, norm, MAX_ISSUES, type Issue } from "./constants";

// дочерние id issue по выбранному типу связи S.
// Направление нормализуется: YouTrack может отдавать OUTBOUND/INBOUND (или OUT/IN/BOTH).
//   OUT-связь («я — stt — они»)  → дети при stt === S;
//   IN-связь («они — stt — я»)   → дети при tts === S;
//   BOTH / недириктальный тип (stt === tts) → совпадение по любому имени.
// Мягкий режим (lenient=true) на случай инвертированных имён типа:
//   IN-связь дополнительно совпадает по stt; неизвестное направление — по любому имени.
//   OUT-связь по tts НЕ совпадаем даже мягко — иначе уйдём вверх по дереву.
export function childIdsOf(it: Issue, S: string, lenient: boolean): string[] {
  if (!S) return [];
  const s = norm(S);
  const out = new Set<string>();
  for (const L of it.links || []) {
    const stt = norm(L.stt), tts = norm(L.tts);
    const d = norm(L.dir);
    const isOut = d.startsWith("out");
    const isIn = d.startsWith("in");
    const isBoth = d.startsWith("both");
    if (stt && stt === tts) { if (stt === s) L.ids.forEach((x) => out.add(x)); continue; }
    const anyName = stt === s || tts === s;
    const strictHit = (isOut && stt === s) || (isIn && tts === s) || (isBoth && anyName);
    const softHit = lenient && ((isIn && stt === s) || (!d && anyName));
    if (strictHit || softHit) L.ids.forEach((x) => out.add(x));
  }
  return [...out];
}

export interface TreeResult {
  items: Issue[];
  limitHit: boolean;
  lenient: boolean;
}

export interface TreeContext {
  cache: Map<string, Issue>;
  fetchBatch: (ids: string[], ctx: unknown, problems: string[], progress?: (l: number, r: number) => void) => Promise<void>;
  problems: string[];
  onProgress?: (loaded: number, left: number) => void;
  loadCtx: unknown;
}

// асинхронный BFS-обход: докачивает уровни по мере необходимости
export async function buildTreeAsync(roots: string[], S: string, ctx: TreeContext): Promise<TreeResult> {
  const { cache, fetchBatch, problems, onProgress, loadCtx } = ctx;
  // корни могли быть указаны без префикса («1») — реальные ключи кеша это idReadable («INFRA-1»);
  // сопоставляем по факту загрузки: к моменту вызова buildTreeAsync корни уже в кеше
  const resolvedRoots = roots.map((id) => {
    if (cache.has(id.toUpperCase())) return id.toUpperCase();
    // ищем по числовому суффиксу (после загрузки idReadable известен)
    const suffix = id.includes("-") ? null : id.replace(/^0+/, "");
    if (suffix) {
      for (const key of cache.keys()) {
        if (key.endsWith("-" + suffix) || key === suffix) return key;
      }
    }
    return id.toUpperCase();
  });
  const seen = new Set(resolvedRoots);
  let frontier: { id: string; depth: number }[] =
    resolvedRoots.filter((id) => cache.has(id)).map((id) => ({ id, depth: 0 }));
  frontier.forEach((f) => seen.add(f.id));
  const items: Issue[] = [];
  let limitHit = false;
  let lenient = false;

  if (S) {
    const strictKids = frontier.reduce((n, f) => n + childIdsOf(cache.get(f.id)!, S, false).length, 0);
    if (!strictKids) {
      const softKids = frontier.reduce((n, f) => n + childIdsOf(cache.get(f.id)!, S, true).length, 0);
      if (softKids) {
        lenient = true;
        problems.push("Строгое сопоставление направления связи не нашло детей — включён мягкий режим (совпадение по любому имени связи). Смотрите «Отладка: сырые связи» ниже.");
      }
    }
  }

  while (frontier.length && !limitHit) {
    const next: { id: string; depth: number }[] = [];
    for (const f of frontier) {
      const it = cache.get(f.id);
      if (!it) continue;
      it.depth = f.depth;
      items.push(it);
      const kids = childIdsOf(it, S, lenient);
      it._kids = kids;
      for (const kid of kids) {
        if (seen.has(kid)) continue;
        seen.add(kid);
        next.push({ id: kid, depth: f.depth + 1 });
        if (items.length + next.length > MAX_ISSUES) { limitHit = true; break; }
      }
      if (limitHit) break;
    }
    if (limitHit || !next.length) break;
    await fetchBatch(next.map((f) => f.id), loadCtx, problems, onProgress);
    frontier = next.filter((f) => cache.has(f.id));
  }
  return { items, limitHit, lenient };
}

// DFS-порядок: каждый ребёнок строго под своим родителем
export function dfsOrder(items: Issue[]): Issue[] {
  const byId = new Map(items.map((i) => [i.id.toUpperCase(), i]));
  const ordered: Issue[] = [];
  const placed = new Set<string>();
  const dfs = (list: Issue[]): void => {
    for (const it of list) {
      if (placed.has(it.id)) continue;
      placed.add(it.id);
      ordered.push(it);
      dfs((it._kids || []).map((id) => byId.get(id)).filter(Boolean) as Issue[]);
    }
  };
  dfs(items.filter((i) => !i.depth));
  for (const it of items)
    if (!placed.has(it.id)) { placed.add(it.id); ordered.push(it); }
  return ordered;
}

export interface Placed { start: Date; end: Date }

// ---- модель расписания «родитель-обёртка» -----------------------------------
//   факты приоритетнее плана: есть дата перехода в статус начала — бар от неё;
//   задача Resolved — бар до resolvedAt (Size при этом — план для задач без факта);
//   корень без факта — от начала оси;
//   первый ребёнок — одновременно с родителем;
//   каждый следующий sibling — после конца предыдущего (каскад внутри поддерева);
//   задача не взята в работу (нет факта старта и Resolved) — не раньше сегодня;
//   родитель с детьми — обёртка: отсчёт от начала работ на дочерней, начатой
//   раньше других (самый ранний факт старта в поддереве), завершение — не раньше
//   самой поздней даты завершения детей (и не раньше собственного факта конца);
//   родитель без детей в выборке — обычная задача со своей длительностью.
export function schedule(issues: Issue[], skipWeekends: boolean, startToday: boolean): Issue[] {
  const resolved = new Map<string, Placed>();
  // есть ли в поддереве фактический труд (Doing/Resolved) и закрыто ли поддерево
  // (не осталось незавершённых) — для отрисовки сплошного бара родителя-обёртки
  const factual = new Map<string, boolean>();
  const closed = new Map<string, boolean>();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const axis = startToday ? nextWorkday(today) : nextWorkday(
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7)));

  const byId = new Map(issues.map((i) => [i.id.toUpperCase(), i]));
  const parentOf = new Map<string, string>();
  for (const it of issues)
    for (const kid of it._kids || []) {
      const k = byId.get(kid.toUpperCase());
      if (k && !parentOf.has(k.id)) parentOf.set(k.id, it.id);
    }

  const barEnd = (start: Date, days: number): Date => {
    const end = new Date(start);
    let left = days - 1;
    while (left > 0) {
      end.setDate(end.getDate() + 1);
      if (skipWeekends && isWeekend(end)) continue;
      left--;
    }
    return end;
  };
  const dayAfter = (d: Date): Date => {
    const x = new Date(d); x.setDate(x.getDate() + 1);
    return skipWeekends ? nextWorkday(x) : x;
  };
  // обратная barEnd: начало бара, заканчивающегося в end длительностью days
  const barStartBefore = (end: Date, days: number): Date => {
    const start = new Date(end);
    let left = days - 1;
    while (left > 0) {
      start.setDate(start.getDate() - 1);
      if (skipWeekends && isWeekend(start)) continue;
      left--;
    }
    return start;
  };

  function place(it: Issue, anchor: Date, stack: Set<string>): Placed {
    const key = it.id.toUpperCase();
    const known = resolved.get(key);
    if (known) return known;
    if (stack.has(key)) {
      const s = new Date(axis);
      factual.set(key, false); closed.set(key, false);
      return { start: s, end: barEnd(s, Math.max(it.days ?? 1, 1)) };
    }
    stack.add(key);

    const kidsInChart = (it._kids || [])
      .map((id) => byId.get(id.toUpperCase()))
      .filter(Boolean) as Issue[];
    const ownKids = kidsInChart.filter((k) => (parentOf.get(k.id) || "").toUpperCase() === key);

    let start: Date, end: Date, estStart: Date, estEnd: Date;
    if (ownKids.length) {
      // родитель-обёртка: отсчёт — самый ранний момент начала работ среди
      // самого родителя и его детей (факт родителя тоже участвует: INFRA-3
      // мог перейти в Doing раньше, чем его дети); завершение — НЕ РАНЬШЕ
      // самой поздней даты завершения детей: если у родителя есть собственный
      // факт конца (Resolved), берём максимум из него и детей
      let prevEnd: Date | null = null;
      // изначально — собственный факт старта родителя, дальше добавляем детей
      let earliestFact: Date | null = it.actualStart ? new Date(it.actualStart) : null;
      let minStart: Date | null = null;     // самый ранний старт ребёнка по каскаду
      let kidFactual = false, allKidsClosed = true;
      for (const k of ownKids) {
        const kAnchor = prevEnd ? dayAfter(prevEnd) : new Date(anchor);
        const r = place(k, kAnchor, stack);
        if (!minStart || r.start < minStart)
          minStart = new Date(r.start);
        if (k.actualStart && (!earliestFact || k.actualStart < earliestFact))
          earliestFact = new Date(k.actualStart);
        kidFactual = kidFactual || !!factual.get(k.id.toUpperCase());
        allKidsClosed = allKidsClosed && !!closed.get(k.id.toUpperCase());
        prevEnd = r.end;
      }
      start = earliestFact ?? minStart!;
      end = new Date(prevEnd!);
      // собственный факт завершения родителя тоже учитываем: бар не может
      // закончиться раньше фактического завершения родительской задачи
      const ownEnd = it.resolved && it.actualEnd ? it.actualEnd : null;
      if (ownEnd && ownEnd > end) end = new Date(ownEnd);
      estStart = new Date(start); estEnd = new Date(end);
      // сплошной бар родителя-обёртки — агрегат по себе и поддереву: он должен
      // начинаться/заканчиваться там же, где обёртка, а не по собственному факту
      const isFactual = !!it.actualStart || kidFactual;
      const isClosed = !!ownEnd || allKidsClosed;
      if (isFactual) {
        it.actualStart = new Date(start);
        // незакрытое поддерево оставляем «в работе» — factSpan доведёт до сегодня
        if (isClosed) it.actualEnd = new Date(end);
      }
      factual.set(key, isFactual); closed.set(key, isClosed);
    } else {
      // лист: факт (переход в статус начала / дата Resolved) перекрывает каскад
      const fStart = it.actualStart || null;
      const fEnd = it.resolved && it.actualEnd ? it.actualEnd : null;
      factual.set(key, !!fStart);
      closed.set(key, !!fEnd);
      if (fStart) {
        // бар оценки — всегда от фактического старта + Size рабочих дней,
        // чтобы шёл параллельно факту и показывал недо-/переоценку срока
        start = new Date(fStart);
        estStart = new Date(fStart);
        estEnd = barEnd(estStart, Math.max(it.days ?? 1, 1));
        end = fEnd && fEnd >= fStart ? new Date(fEnd) : new Date(estEnd);
      } else if (fEnd) {
        // завершён, но истории начала нет: план Size уходит назад от resolvedAt
        end = new Date(fEnd);
        start = barStartBefore(end, Math.max(it.days ?? 1, 1));
        estStart = new Date(start); estEnd = new Date(end);
      } else {
        // не взята в работу: план не может начинаться раньше сегодняшнего дня
        // (якорь из каскада мог уехать в прошлое); при пропуске выходных —
        // не раньше ближайшего рабочего дня
        start = anchor < today
          ? (skipWeekends ? nextWorkday(today) : new Date(today))
          : new Date(anchor);
        estStart = new Date(start);
        end = barEnd(start, Math.max(it.days ?? 1, 1));
        estEnd = new Date(end);
      }
    }

    stack.delete(key);
    it.estStart = estStart;
    it.estEnd = estEnd;
    const r = { start, end };
    resolved.set(key, r);
    return r;
  }

  for (const it of issues) {
    const r = place(it, new Date(axis), new Set());
    it.start = r.start; it.end = r.end;
  }
  return issues;
}
