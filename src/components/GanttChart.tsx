// Диаграмма Ганта на MUI Table + SVG-бары.
// Чистая отрисовка: данные приходят готовыми. Колонка задач — sticky слева,
// ось с барами скроллится горизонтально. Масштаб: авто — 8 недель на экр��н
// (по ширине контейнера), кнопками «−»/«+» — вручную.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Stack, Table, TableBody, TableCell, TableHead, TableRow, Tooltip } from "@mui/material";
import {
  COLORS, DAY_PX, DAY_PX_MAX, DAY_PX_MIN, ROW_H, TOP, ZOOM_STEP,
  LABEL_W_DEFAULT, LABEL_W_MAX, LABEL_W_MIN,
  calendarDaysBetween, clampDayPx, factSpan, fitWeeks, fmtDate, isWeekend, issueUrl,
  loadLabelW, saveLabelW, workdaysBetween, type Issue,
} from "../lib/constants";

// строки для отображения: выкидываем поддеревья свёрнутых родителей
export function visibleRows(ordered: Issue[], collapsed: ReadonlySet<string>): Issue[] {
  const out: Issue[] = [];
  let skipDeeperThan = -1;
  for (const it of ordered) {
    const d = it.depth || 0;
    if (skipDeeperThan >= 0) {
      if (d > skipDeeperThan) continue;
      skipDeeperThan = -1;
    }
    out.push(it);
    if (collapsed.has(it.id)) skipDeeperThan = d;
  }
  return out;
}

interface Geometry { min: Date; totalDays: number; labelW: number; chartW: number }

function geometry(ordered: Issue[], dayPx: number, labelW: number): Geometry | null {
  if (!ordered.length) return null;
  // ось должна вместить всё: план (start/end), бар оценки (est) и факт
  // (включая «в работе» — он тянется до сегодняшнего дня)
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const spans: { s: Date; e: Date }[] = [{ s: ordered[0].start!, e: ordered[0].end! }];
  for (const i of ordered) {
    spans.push({ s: i.start!, e: i.end! });
    if (i.estStart) spans.push({ s: i.estStart, e: i.estEnd ?? i.estStart });
    const f = factSpan(i, today);
    if (f) spans.push({ s: f.start, e: f.end });
  }
  const min = spans.reduce((m, x) => (x.s < m ? x.s : m), spans[0].s);
  const max = spans.reduce((m, x) => (x.e > m ? x.e : m), spans[0].e);
  const totalDays = Math.round((max.getTime() - min.getTime()) / 86400000) + 1;
  return {
    min, totalDays, labelW,
    chartW: totalDays * dayPx + 20,
  };
}

interface Props { issues: Issue[]; skipWeekends: boolean; baseUrl: string }

export default function GanttChart({ issues, skipWeekends, baseUrl }: Props): React.ReactElement {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // ширина области графика (замеряется по контейнеру); 0 — до первого замера
  const [viewport, setViewport] = useState(0);
  // px за день; null = авто-масштаб (8 недель на экран)
  const [zoom, setZoom] = useState<number | null>(null);
  // ширина колонки задач: тянется за край шапки, размер — в localStorage
  const [labelW, setLabelW] = useState<number>(loadLabelW);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setViewport(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ordered = useMemo(() => visibleRows(issues, collapsed), [issues, collapsed]);

  // доступная ширина под ось: контейнер минус колонка задач и правый запас
  const plotW = viewport - labelW - 20;
  const autoDayPx = fitWeeks(plotW);
  const dayPx = zoom ?? autoDayPx;

  const geom = useMemo(() => geometry(ordered, dayPx, labelW), [ordered, dayPx, labelW]);

  // перетаскивание правого края шапки к��лонки задач; на отпускании — в localStorage
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault();
    const drag = { x: e.clientX, w: labelW };
    const onMove = (ev: MouseEvent): void => {
      const w = Math.min(LABEL_W_MAX, Math.max(LABEL_W_MIN, drag.w + ev.clientX - drag.x));
      setLabelW(w);
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setLabelW((w) => { saveLabelW(w); return w; });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (!issues.length) return <div className="legend-item">Нет задач для отображения.</div>;
  if (!geom) return <div className="legend-item">Нет задач для отображения.</div>;

  const { min, totalDays, chartW } = geom;
  // id в верхнем регистре: YouTrack отдаёт idReadable в любом регистре,
  // а _kids всегда в верхнем — иначе у родителей пропадёт стрелка сворачивания
  const byIdAll = new Set(issues.map((i) => i.id.toUpperCase()));
  const toggle = (id: string, open: boolean): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.add(id); else next.delete(id);
      return next;
    });

  // сетка: подписи дат — в шапке таблицы, линии и подсветка выходных — в каждой строке
  const gridLabels: React.ReactElement[] = [];
  const gridLineXs: number[] = [];
  const weekendXs: number[] = [];
  // подписи понедельников имеет смысл рисовать, когда день шире ~8px
  const weeklyLabels = dayPx >= 8;
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(min); d.setDate(d.getDate() + i);
    const x = i * dayPx;
    if (skipWeekends && isWeekend(d) && dayPx >= 4) weekendXs.push(x);
    if (weeklyLabels ? (d.getDay() === 1 || d.getDate() === 1) : d.getDate() === 1) {
      gridLabels.push(
        <text key={"lb" + i} x={x + 3} y={16} fill="#66738c">
          {d.toLocaleDateString("ru-RU", { day: "2-digit", month: "short" })}
        </text>,
      );
      gridLineXs.push(x);
    }
  }

  const now = new Date(); now.setHours(0, 0, 0, 0);
  const todayIdx = Math.round((now.getTime() - min.getTime()) / 86400000);
  const todayX = todayIdx >= 0 && todayIdx < totalDays ? todayIdx * dayPx + dayPx / 2 : null;

  const labelSvg = (it: Issue): React.ReactElement => {
    const color = COLORS[(it.depth || 0) % COLORS.length];
    const indent = Math.min(it.depth || 0, 6) * 14;
    // глубина дерева видна и по вертикали: каждый дочерний уровень — на ширину
    // буквы (~7px) ниже своего родителя; бары остаются привязаны к оси времени
    const vShift = Math.min(it.depth || 0, 3) * 7;
    const baseY = 12 + vShift;
    const isResolved = !!it.resolved;
    const hasKids = (it._kids || []).some((id) => byIdAll.has(id.toUpperCase()));
    const open = !collapsed.has(it.id);
    const prefix = (it.depth || 0) > 0 ? "↳ " : "";
    // сколько символов влезает: ≈7.5px на букву при 14px шрифте
    const maxLen = Math.max(20, Math.floor((labelW - 24 - indent - (hasKids ? 16 : 0)) / 7.5));
    const summary = it.summary.length > maxLen ? it.summary.slice(0, maxLen - 1) + "…" : it.summary;
    return (
      // наведение на строку названия — тултип с полным названием задачи
      <Tooltip title={it.summary} arrow enterDelay={400} placement="top-start">
        <svg width={labelW} height={ROW_H} className="gantt-label-svg">
          {hasKids && (
            <>
              <rect x={2 + indent} y={4} width={16} height={ROW_H - 8} fill="transparent"
                    style={{ cursor: "pointer" }} onClick={() => toggle(it.id, open)} />
              <text x={8 + indent} y={baseY} fill="#66738c" fontWeight={700}
                    style={{ cursor: "pointer" }} onClick={() => toggle(it.id, open)}>
                {open ? "▾" : "▸"}
              </text>
            </>
          )}
          <text x={8 + indent + (hasKids ? 16 : 0)} y={baseY}
                fill={isResolved ? "#9aa5ba" : "#1c2433"}
                textDecoration={isResolved ? "line-through" : "none"}>
            <a href={issueUrl(baseUrl, it.id)} target="_blank" rel="noopener noreferrer">
              <tspan fontWeight={600} fill={color} textDecoration="underline" style={{ cursor: "pointer" }}>
                {prefix + it.id}
              </tspan>
            </a>
            {"  "}
            <tspan fill="#66738c">{summary}</tspan>
          </text>
        </svg>
      </Tooltip>
    );
  };

  const barSvg = (it: Issue): React.ReactElement => {
    const y = 0;
    const color = COLORS[(it.depth || 0) % COLORS.length];
    const isResolved = !!it.resolved;

    // бар оценки (план по Size): верхняя дорожка строки
    const estStart = it.estStart ?? it.start!;
    const estEnd = it.estEnd ?? it.end!;
    const estIdx0 = Math.round((estStart.getTime() - min.getTime()) / 86400000);
    const estLen = Math.round((estEnd.getTime() - estStart.getTime()) / 86400000) + 1;
    const ex = estIdx0 * dayPx;
    const ew = Math.max(estLen * dayPx - 3, 6);

    // бар факта (нижняя дорожка) + реальная длительность к.д./р.д.
    const fact = factSpan(it, now);
    const calD = fact ? calendarDaysBetween(fact.start, fact.end) : 0;
    const workD = fact ? workdaysBetween(fact.start, fact.end) : 0;
    const fIdx0 = fact ? Math.round((fact.start.getTime() - min.getTime()) / 86400000) : 0;
    const fIdx1 = fact ? Math.round((fact.end.getTime() - min.getTime()) / 86400000) : 0;
    const fx = fIdx0 * dayPx;
    const fw = Math.max((fIdx1 - fIdx0) * dayPx + dayPx - 3, 6);

    return (
      <svg width={chartW} height={ROW_H} viewBox={`0 0 ${chartW} ${ROW_H}`} data-tid="gantt-svg">
        {weekendXs.map((x, i) => (
          <rect key={"we" + i} x={x} y={y} width={dayPx} height={ROW_H} fill="#1c2433" opacity={0.05} />
        ))}
        {gridLineXs.map((x, i) => (
          <line key={"ln" + i} x1={x} y1={y} x2={x} y2={ROW_H} stroke="#d9e0ea" strokeDasharray="3,3" />
        ))}
        {todayX !== null && (
          <line x1={todayX} y1={y} x2={todayX} y2={ROW_H} stroke="#c8384a" strokeWidth={1.5} />
        )}
        {/* оценка (план по Size) — верхняя дорожка, пунктир */}
        <g>
          <title>
            {`Оценка «${it.sizeRaw || "?"}» — ${it.days} дн. (план): ${fmtDate(estStart)} — ${fmtDate(estEnd)}${isResolved ? "\nСостояние: Resolved ✓" : ""}`}
          </title>
          <rect x={ex} y={y + 5} width={ew} height={10} rx={3}
                fill={color} opacity={0.25} stroke={color} strokeDasharray="4,3" />
          {ew >= 18 && (
            <text x={ex + ew / 2} y={y + 13} fontSize={9} fontWeight={600} textAnchor="middle" fill={color}>
              {`${it.days}д${isResolved ? " ✓" : ""}`}
            </text>
          )}
          {fact && (
            <g>
              {/* факт — нижняя дорожка: переход в статус начала → Resolved (или сегодня) */}
              <title>
                {`Факт: ${fmtDate(fact.start)} — ${fmtDate(fact.end)}${fact.open ? " (в работе)" : ""}\n` +
                 `Реальная длительность: ${calD} к.д. / ${workD} р.д.`}
              </title>
              <rect x={fx} y={y + 19} width={fw} height={10} rx={3}
                    fill={isResolved ? "#9aa5ba" : color}
                    opacity={isResolved ? 0.45 : 0.85}
                    stroke={isResolved ? color : "none"}
                    strokeDasharray={isResolved ? "4,3" : "none"} />
              <text x={fx + fw + 6} y={y + 27} fontSize={10} fill="#66738c">
                {`${calD} к.д. / ${workD} р.д.`}
              </text>
            </g>
          )}
        </g>
      </svg>
    );
  };

  const weeksVisible = plotW > 0 ? Math.max(1, Math.round(plotW / dayPx / 7)) : null;

  return (
    <Box ref={wrapRef}>
      {/* масштаб: авто — 8 недель на экран, «−»/«+» — ручной (шаг ×1.25) */}
      <Stack direction="row" spacing={1} className="zoombar" sx={{ mb: 1, alignItems: "center" }}>
        <Button size="small" variant="outlined" aria-label="Уменьшить масштаб"
                disabled={dayPx <= DAY_PX_MIN}
                onClick={() => setZoom(clampDayPx(dayPx / ZOOM_STEP))}>−</Button>
        <Button size="small" variant="outlined" aria-label="Увеличить масштаб"
                disabled={dayPx >= DAY_PX_MAX}
                onClick={() => setZoom(clampDayPx(dayPx * ZOOM_STEP))}>+</Button>
        <Button size="small" variant="outlined" disabled={zoom === null}
                onClick={() => setZoom(null)}>8 недель</Button>
        {weeksVisible && <span className="zoom-label">≈ {weeksVisible} нед. на экране</span>}
      </Stack>
      <Box sx={{ overflowX: "auto" }}>
        {/* ширина точная в px: колонка задач + ось с барами, без лишнего скролла */}
        <Table className="gantt-table" sx={{ tableLayout: "fixed", width: labelW + chartW, borderCollapse: "separate" }}>
          <TableHead>
            <TableRow>
              <TableCell className="gantt-label-col" sx={{ width: labelW, p: 0, border: 0 }}>
                <span className="gantt-col-title">Задача</span>
                {/* правый край шапки — ручка изменения ширины колонки задач */}
                <span className="gantt-resizer" onMouseDown={startResize}
                      role="separator" aria-orientation="vertical"
                      aria-label="Изменить ширину колонки задач" title="Потяните, чтобы изменить ширину колонки" />
              </TableCell>
              <TableCell sx={{ p: 0, border: 0 }}>
                <svg width={chartW} height={TOP} data-tid="gantt-axis">
                  {weekendXs.map((x, i) => (
                    <rect key={"we" + i} x={x} y={TOP - 20} width={dayPx} height={20} fill="#1c2433" opacity={0.05} />
                  ))}
                  {gridLabels}
                  {gridLineXs.map((x, i) => (
                    <line key={"ln" + i} x1={x} y1={24} x2={x} y2={TOP} stroke="#d9e0ea" strokeDasharray="3,3" />
                  ))}
                  {todayX !== null && (
                    <g>
                      <line x1={todayX} y1={TOP - 20} x2={todayX} y2={TOP} stroke="#c8384a" strokeWidth={1.5} />
                      <text x={todayX + 4} y={TOP - 26} fill="#c8384a">сегодня</text>
                    </g>
                  )}
                </svg>
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {ordered.map((it) => (
              <TableRow key={it.id}>
                <TableCell className="gantt-label-col" data-tid="gantt-labels" sx={{ width: labelW, p: 0, border: 0 }}>
                  {labelSvg(it)}
                </TableCell>
                <TableCell sx={{ p: 0, border: 0 }}>
                  {barSvg(it)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
    </Box>
  );
}
