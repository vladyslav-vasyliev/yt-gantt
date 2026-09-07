// Главный компонент: состояние формы, валидации, сборка данных, тост-уведомления.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Stack, ThemeProvider, createTheme } from "@mui/material";
import SettingsForm from "./components/SettingsForm";
import GanttChart from "./components/GanttChart";
import {
  loadSettings, saveSettings, parseIds, applyProjectPrefix, fmtDate,
  SIZE_MAP, MAX_ISSUES, type AppSettings, type Issue,
} from "./lib/constants";
import { cache, fetchBatch, collectMetaFromIssues, collectLinkTypes, computeActualStart, idsWithoutHistory, PROXY } from "./lib/youtrack";
import { buildTreeAsync, dfsOrder, schedule, type TreeContext } from "./lib/tree";

// тема: наследуем системный шрифт проекта, остальное — дефолты MUI
const theme = createTheme({
  typography: { fontFamily: "-apple-system, 'Segoe UI', Roboto, Arial, sans-serif" },
});

type Severity = "info" | "warning" | "error";

interface ToastItem { id: number; message: string; severity: Severity }

interface ToastApi {
  push: (m: string, cfg?: { use?: Severity }) => void;
}

// каждый тост живёт 6 секунд, затем сам убирается из стека
function ToastEntry({ item, onClose }: { item: ToastItem; onClose: (id: number) => void }): React.ReactElement {
  useEffect(() => {
    const h = setTimeout(() => onClose(item.id), 6000);
    return () => clearTimeout(h);
  }, [item.id, onClose]);
  return (
    <Alert severity={item.severity} onClose={() => onClose(item.id)} sx={{ boxShadow: 3, alignItems: "center" }}>
      {item.message}
    </Alert>
  );
}

// стек тостов в правом нижнем углу (аналог Toast из react-ui)
function ToastStack({ items, onClose }: { items: ToastItem[]; onClose: (id: number) => void }): React.ReactElement {
  return (
    <Stack spacing={1} sx={{ position: "fixed", bottom: 24, right: 24, zIndex: (t) => t.zIndex.snackbar, maxWidth: 520 }}>
      {items.map((t) => <ToastEntry key={t.id} item={t} onClose={onClose} />)}
    </Stack>
  );
}

interface ChartData {
  issues: Issue[];
  summary: string;
  problems: string[];
  baseUrl: string;
  skipWeekends: boolean;
}

// строгая проверка перед запуском (поверх инлайн-валидаций формы)
const validateForm = (s: AppSettings): string[] => {
  const errors: string[] = [];
  if (!s.baseUrl.trim()) errors.push("Укажите URL YouTrack");
  else if (!s.baseUrl.trim().startsWith("http")) errors.push("URL должен начинаться с http(s)://");
  if (!s.token.trim()) errors.push("Укажите permanent token");
  if (!parseIds(s.ids).length) errors.push("Не распознан ни один идентификатор");
  return errors;
};

export default function App(): React.ReactElement {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false); // тикеты в кеше → поля и «Построить» доступны
  const [loadProblems, setLoadProblems] = useState<string[]>([]);
  const [chart, setChart] = useState<ChartData | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextToastId = useRef(0);

  const closeToast = useCallback((id: number): void =>
    setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  const pushToast = useCallback((message: string, severity: Severity): void => {
    const id = ++nextToastId.current;
    // стек не длиннее пяти: старые вытесняются новыми
    setToasts((prev) => [...prev.slice(-4), { id, message, severity }]);
  }, []);

  const toast = useMemo<ToastApi>(() => ({
    push: (m, cfg) => pushToast(m, cfg?.use ?? "info"),
  }), [pushToast]);

  // сетевые ошибки не молчим: каждая — в тост. Чтобы лавина 500-х не завалила
  // экран, первые 5 показываем поштучно, дальше — один суммарный тост
  const networkToaster = useCallback((t: ToastApi): ((msg: string) => void) => {
    let shown = 0;
    return (msg: string): void => {
      shown += 1;
      if (shown <= 5) t.push(msg, { use: "error" });
      else if (shown === 6) t.push("…и ещё ошибки сети — полный список под диаграммой", { use: "error" });
    };
  }, []);

  const set = (patch: Partial<AppSettings>): void => setSettings((s) => {
    const next = { ...s, ...patch };
    saveSettings(next);
    return next;
  });

  // Шаг 1 — «Загрузить задачи»: тикеты из списка + их истории изменений.
  // Каждый клик перечитывает всё из YouTrack (свежие данные).
  const load = async (): Promise<void> => {
    const errors = validateForm(settings);
    if (errors.length) {
      toast.push(errors.join(" · "), { use: "error" });
      return;
    }
    if (!PROXY) {
      toast.push("Страница открыта не через server.cjs — CORS может заблокировать запросы. Запустите: node server.cjs", { use: "warning" });
    }

    const base = settings.baseUrl.trim().replace(/\/+$/, "");
    const token = settings.token.trim();
    const sizeField = settings.sizeField.trim() || "Size";
    const roots = parseIds(applyProjectPrefix(settings.ids, settings.project.trim().toUpperCase()));

    setBusy(true);
    setShowProblems(false);
    const problems: string[] = [];
    try {
      cache.clear();
      await fetchBatch(roots, { base, token, sizeField, onNetworkError: networkToaster(toast) }, problems,
        (n) => toast.push(`Загружено ${n} issue…`));
      if (!cache.size) {
        toast.push("Ни одна задача не загружена. " + problems.slice(0, 3).join(" · "), { use: "error" });
        return;
      }
      setLoaded(true);
      setLoadProblems(problems);
      setChart(null); // прежний график построен по предыдущим данным
      // тихий отказ истории (403/сеть) внешне не заметен — сообщаем сразу
      const noHist = idsWithoutHistory([...cache.values()]);
      if (noHist.length) {
        problems.push(`История изменений недоступна для: ${noHist.slice(0, 5).join(", ")}${noHist.length > 5 ? ` … (+${noHist.length - 5})` : ""} — дата статуса начала не определится`);
        setLoadProblems(problems);
        toast.push(`Загружено задач: ${cache.size}, но у ${noHist.length} нет истории изменений (проверьте права токена на activities/history)`, { use: "warning" });
      } else {
        toast.push(`Загружено задач: ${cache.size}` + (problems.length ? ` · с ошибками: ${problems.length}` : ""));
      }
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Ошибка", { use: "error" });
    } finally {
      setBusy(false);
    }
  };

  // Шаг 2 — «Построить»: дерево по выбранной связи (дети докачиваются),
  // факт считается из сохранённых историй п�� выбранным после загрузки полям.
  const build = async (): Promise<void> => {
    if (!cache.size) {
      toast.push("Сначала загрузите задачи кнопкой «Загрузить задачи»", { use: "error" });
      return;
    }

    const base = settings.baseUrl.trim().replace(/\/+$/, "");
    const token = settings.token.trim();
    const sizeField = settings.sizeField.trim() || "Size";
    const stateField = settings.stateField.trim() || "State";
    const startStatus = settings.startStatus.trim();
    const linkTypeName = settings.linkType.trim();
    const roots = parseIds(applyProjectPrefix(settings.ids, settings.project.trim().toUpperCase()));

    setBusy(true);
    setShowProblems(false);
    const problems: string[] = [...loadProblems];

    try {
      const loadCtx = { base, token, sizeField, onNetworkError: networkToaster(toast) };
      const ctx = {
        cache, fetchBatch: fetchBatch as unknown as TreeContext["fetchBatch"], problems, loadCtx,
        onProgress: (loaded: number): void => toast.push(`Загружено ${loaded} issue…`),
      };

      const { items, limitHit } = await buildTreeAsync(roots, linkTypeName, ctx);

      const gotChildren = items.some((it) => (it.depth || 0) > 0);
      if (limitHit) problems.push(`Достигнут лимит ${MAX_ISSUES} задач — поддерево обрезано.`);
      if (linkTypeName && !gotChildren && cache.size > 0)
        problems.push(`Дети по связи «${linkTypeName}» не найдены ни в строгом, ни в мягком режиме (проверьте имя связи).`);

      const ordered = dfsOrder(items);

      const chartIssues: Issue[] = [];
      for (const it of ordered) {
        // факт вычисляем здесь: поля статуса выбираются уже после загрузки тикетов
        it.actualStart = startStatus ? computeActualStart(it, stateField, startStatus) : null;
        it.actualEnd = it.resolvedAt;
        const key = (it.sizeRaw || "").toUpperCase();
        const original = it.sizeRaw;
        if (SIZE_MAP[key] != null) {
          it.days = SIZE_MAP[key];
        } else {
          it.days = SIZE_MAP.M;
          it.sizeRaw = "M*";
          problems.push(original
            ? `${it.id}: «${sizeField}» = "${original}" (неизвестное значение) — принят размер M (${SIZE_MAP.M} дн.)`
            : `${it.id}: поле «${sizeField}» не задано — принят размер M (${SIZE_MAP.M} дн.)`);
        }
        chartIssues.push(it);
      }

      if (!chartIssues.length) {
        toast.push("Задачи из списка не загружены — измените список и нажмите «Загрузить задачи».", { use: "error" });
        return;
      }

      schedule(chartIssues, settings.skipWeekends, settings.startToday);

      const rootCount = chartIssues.filter((i) => !i.depth).length;
      const maxDepth = chartIssues.reduce((m, i) => Math.max(m, i.depth || 0), 0);
      const totalDays = chartIssues.reduce((s, i) => s + (i.days || 0), 0);
      const summary =
        `Задач: ${chartIssues.length} (корневых: ${rootCount}, дочерних: ${chartIssues.length - rootCount}` +
        `${linkTypeName ? `, тип связи: «${linkTypeName}»` : ""}, глубина: ${maxDepth})` +
        ` · суммарный размер: ${totalDays} дн. · окончание: ${fmtDate(chartIssues[chartIssues.length - 1].end!)}`;

      setChart({ issues: chartIssues, summary, problems, baseUrl: base, skipWeekends: settings.skipWeekends });
      if (problems.length) {
        toast.push(`Готово, но есть предупреждения (${problems.length}) — смотри под диаграммой`, { use: "warning" });
      } else {
        toast.push(`Загружено задач: ${chartIssues.length}`);
      }
    } catch (e) {
      const message = (e instanceof Error ? e.message : "Ошибка");
      toast.push(message + (problems.length ? " · " + problems.slice(0, 3).join(" · ") : ""), { use: "error" });
    } finally {
      setBusy(false);
    }
  };

  // селекты наполняются реальными значениями из загруженных тикетов
  // (пересчёт после загрузки и после построения — истории детей добавляют статусы)
  const meta = useMemo(() => (cache.size ? collectMetaFromIssues(settings.stateField) : { fieldNames: [], statuses: [] }), [loaded, chart, settings.stateField]);
  const linkTypeOptions = useMemo(() => (cache.size ? collectLinkTypes() : []), [loaded, chart]);

  return (
    <ThemeProvider theme={theme}>
      <ToastStack items={toasts} onClose={closeToast} />

      {/* шапка: продуктовое название, навигации нет — бургер не нужен */}
      <header className="topbar">
        <div className="shell topbar-in">
          <span className="brand">YouTrack&nbsp;→&nbsp;Gantt</span>
          <span className="brand-note">расписание задач по связям, плану и факту</span>
        </div>
      </header>

      <main className="shell content">
        {/* шапка контент-зоны: заголовок раздела; основные действия — справа */}
        <div className="content-head">
          <h1>Диаграмма Ганта</h1>
          <span className="content-head-note">два шага: загрузить задачи → выбрать поля и построить</span>
        </div>

        <SettingsForm
          settings={settings}
          setSettings={set}
          linkTypeOptions={linkTypeOptions}
          fieldNames={meta.fieldNames}
          statuses={meta.statuses}
          loaded={loaded}
          onLoad={load}
          onBuild={build}
          busy={busy}
        />

        <div className="hint">
          Дочерние тикеты подтягиваются по выбранному типу связи (рекурсивно, всё поддерево) и
          показываются под своими родителями. Расписание — модель «родитель-обёртка», факты важнее
          плана: задача рисуется от даты перехода в «Статус начала работы», завершённая — до даты
          Resolved (размер из «Size» — план только для задач без факта). Родитель отсчитывается
          от момента начала работ на дочерней, над которой раньше других начали работу. Без факта:
          первый ребёнок стартует одновременно с родителем, следующий sibling — после предыдущего,
          корни — от начала оси. Имя связи — такое, под которым дети видны на тикете (для
          стандартной иерархии это <code>parent for</code>). Если поле Size пустое или
          неизвестно — задача считается <b>M</b> (10 дн.).
        </div>

        {chart ? (
          <section className="panel">
            <div className="summary-row"><div className="legend-item">{chart.summary}</div></div>
            <GanttChart issues={chart.issues} skipWeekends={chart.skipWeekends} baseUrl={chart.baseUrl} />
            {chart.problems.length > 0 && (
              <div className="problems">
                <a className="problems-toggle" onClick={() => setShowProblems((v) => !v)}>
                  {showProblems ? "▾" : "▸"} Предупреждения ({chart.problems.length})
                </a>
                {showProblems && (
                  <ul>{chart.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
                )}
              </div>
            )}
            <div className="legend-item legend">
              Верхний пунктирный бар — оценка по «Полю размера» (план). Нижний сплошной — факт:
              от перехода в «Статус начала работы» до Resolved (незавершённые — до сегодня);
              справа от него — реальная длительность в календарных (к.д.) и рабочих (р.д.) днях.
              Зачёркнутая строка и серый бар — задача в состоянии Resolved.
            </div>
          </section>
        ) : (
          /* пустое состояние: страницу белой не оставляем */
          <section className="panel empty">
            <div className="empty-title">График ещё не построен</div>
            <div className="empty-text">
              Укажите адрес YouTrack и токен, загрузите задачи из списка,
              выберите поля и нажмите «Построить».
            </div>
          </section>
        )}
      </main>

      {/* подвал: лаконично, минимальный набор ссылок */}
      <footer className="footer">
        <div className="shell footer-in">
          <span>Токен хранится только в localStorage · Запуск: <code>node server.cjs</code> → http://localhost:8414</span>
        </div>
      </footer>
    </ThemeProvider>
  );
}
