// Главный компонент: состояние формы, валидации, сборка данных, тост-уведомления.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppBar, Stack, ThemeProvider, Toolbar, Typography, createTheme } from "@mui/material";
import SettingsForm from "./components/SettingsForm";
import GanttChart from "./components/GanttChart";
import {
  loadSettings, saveSettings, parseIds, applyProjectPrefix,
  MAX_ISSUES, type AppSettings, type Issue,
} from "./lib/constants";
import {
  callSizeLambda, callStartLambda,
  compileSizeLambda, compileStartLambda,
  DEFAULT_SIZE_LAMBDA, DEFAULT_START_LAMBDA,
  loadSizeLambda, loadStartLambda, saveSizeLambda, saveStartLambda,
  resetSizeLambda, resetStartLambda,
} from "./lib/lambda";
import { cache, fetchBatch, idsWithoutHistory, PROXY } from "./lib/youtrack";
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
  const [chart, setChart] = useState<ChartData | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextToastId = useRef(0);
  // липкая шапка: её высота нужна панели масштаба, чтобы прилипать точно под ней
  const appbarRef = useRef<HTMLElement | null>(null);
  // лямбды расчёта (таб «Расчёт»): тексты редактируются в форме,
  // компилируются при построении; размер в localStorage
  const [sizeLambda, setSizeLambda] = useState<string>(loadSizeLambda);
  const [startLambda, setStartLambda] = useState<string>(loadStartLambda);

  const changeSizeLambda = useCallback((code: string): void => {
    setSizeLambda(code);
    saveSizeLambda(code);
  }, []);
  const changeStartLambda = useCallback((code: string): void => {
    setStartLambda(code);
    saveStartLambda(code);
  }, []);
  const resetSizeLambdaText = useCallback((): void =>
    setSizeLambda(resetSizeLambda()), []);
  const resetStartLambdaText = useCallback((): void =>
    setStartLambda(resetStartLambda()), []);

  // высота липкой шапки → CSS-переменная; панель масштаба прилипает под ней
  useEffect(() => {
    const el = appbarRef.current;
    if (!el) return;
    const apply = (): void =>
      document.documentElement.style.setProperty("--appbar-h", `${el.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
      setChart(null); // прежний график построен по предыдущим данным
      // тихий отказ истории (403/сеть) внешне не заметен — сообщаем сразу
      const noHist = idsWithoutHistory([...cache.values()]);
      if (noHist.length) {
        problems.push(`История изменений недоступна для: ${noHist.slice(0, 5).join(", ")}${noHist.length > 5 ? ` … (+${noHist.length - 5})` : ""} — дата статуса начала не определится`);
        toast.push(`Загружено задач: ${cache.size}, но у ${noHist.length} нет истории изменений (проверьте права токена на activities/history)`, { use: "warning" });
      } else {
        toast.push(`Загружено задач: ${cache.size}` + (problems.length ? ` · с ошибками: ${problems.length}` : ""));
      }
      // отдельной кнопки «Построить» нет — строим график сразу после загрузки
      await buildChart(problems);
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Ошибка", { use: "error" });
    } finally {
      setBusy(false);
    }
  };

  // построение дерева и расписания по уже загруженному кешу (вызывается из load)
  const buildChart = async (baseProblems: string[]): Promise<void> => {
    const base = settings.baseUrl.trim().replace(/\/+$/, "");
    const token = settings.token.trim();
    const sizeField = settings.sizeField.trim() || "Size";
    const linkTypeName = settings.linkType.trim();
    const roots = parseIds(applyProjectPrefix(settings.ids, settings.project.trim().toUpperCase()));

    // лямбды компилируются на каждый запуск: пользователь мог изменить текст
    const sizeRes = compileSizeLambda(sizeLambda);
    const startRes = compileStartLambda(startLambda);
    if (sizeRes.error) toast.push(sizeRes.error + " — используется лямбда по умолчанию", { use: "warning" });
    if (startRes.error) toast.push(startRes.error + " — используется лямбда по умолчанию", { use: "warning" });
    const sizeFn = sizeRes.fn ?? compileSizeLambda(DEFAULT_SIZE_LAMBDA).fn!;
    const startFn = startRes.fn ?? compileStartLambda(DEFAULT_START_LAMBDA).fn!;

    setShowProblems(false);
    const problems: string[] = [...baseProblems];

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
        // факт и размер — через лямбды (issue + история изменений)
        it.actualStart = callStartLambda(startFn, it, problems);
        it.actualEnd = it.resolvedAt;
        it.days = callSizeLambda(sizeFn, it, problems);
        chartIssues.push(it);
      }

      if (!chartIssues.length) {
        toast.push("Задачи из списка не загружены — измените список и нажмите «Загрузить задачи».", { use: "error" });
        return;
      }

      // план всегда отсчитываем от сегодняшнего дня
      schedule(chartIssues, settings.skipWeekends, true);

      const rootCount = chartIssues.filter((i) => !i.depth).length;
      const maxDepth = chartIssues.reduce((m, i) => Math.max(m, i.depth || 0), 0);
      const summary =
        `Задач: ${chartIssues.length} (корневых: ${rootCount}, дочерних: ${chartIssues.length - rootCount}` +
        `${linkTypeName ? `, тип связи: «${linkTypeName}»` : ""}, глубина: ${maxDepth})`;

      setChart({ issues: chartIssues, summary, problems, baseUrl: base, skipWeekends: settings.skipWeekends });
      if (problems.length) {
        toast.push(`Готово, но есть предупреждения (${problems.length}) — смотри под диаграммой`, { use: "warning" });
      } else {
        toast.push(`Загружено задач: ${chartIssues.length}`);
      }
    } catch (e) {
      const message = (e instanceof Error ? e.message : "Ошибка");
      toast.push(message + (problems.length ? " · " + problems.slice(0, 3).join(" · ") : ""), { use: "error" });
    }
  };

  return (
    <ThemeProvider theme={theme}>
      <ToastStack items={toasts} onClose={closeToast} />

      {/* шапка: продуктовое название, навигации нет — бургер не нужен;
          липкая — заголовок остаётся видимым при скроле длинной диаграммы */}
      <AppBar ref={appbarRef} position="sticky" sx={{ top: 0 }}>
        <Toolbar sx={{ justifyContent: "center", minHeight: 56 }}>
          <Typography variant="h6" component="div">Диаграмма Ганта</Typography>
        </Toolbar>
      </AppBar>

      <main className="shell content">
        <SettingsForm
          settings={settings}
          setSettings={set}
          onLoad={load}
          busy={busy}
          sizeLambda={sizeLambda}
          startLambda={startLambda}
          onSizeLambdaChange={changeSizeLambda}
          onStartLambdaChange={changeStartLambda}
          onSizeLambdaReset={resetSizeLambdaText}
          onStartLambdaReset={resetStartLambdaText}
        />

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
              Верхний пунктирный бар — оценка по «Полю размера» (план); если размер не
              задан, у родителя план — по границам поддерева, у листа бара нет.
              Нижний сплошной — факт:
              от перехода в «Статус начала работы» до Resolved (незавершённые — до сегодня).
              Если дети (по плану или факту) заканчиваются позже фактического завершения
              задачи — от конца сплошного бара до самого позднего завершения ребёнка идёт
              слабо окрашенный пунктирный хвост. Справа — реальная
              длительность в календарных (к.д.) и рабочих (р.д.) днях.
              Зачёркнутая строка и серый бар — задача в состоянии Resolved.
            </div>
          </section>
        ) : (
          /* пустое состояние: страницу белой не оставляем */
          <section className="panel empty">
            <div className="empty-title">График ещё не построен</div>
            <div className="empty-text">
              Укажите адрес YouTrack и токен, задайте идентификаторы задач
              и нажмите «Загрузить задачи» — график построится сразу.
            </div>
          </section>
        )}
      </main>
    </ThemeProvider>
  );
}

