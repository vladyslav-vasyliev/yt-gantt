// Форма настроек на Material UI.
// ВАЖНО: setSettings из App — готовый апдейтер (patch → сохранение → state),
// вторично оборачивать его в setState нельзя — иначе ввод в поля не работает.
//
// Три таба:
//   «Задачи» (открывается по умолчанию) — идентификаторы, «Загрузить задачи»,
//     тип связи дочерних, чекбоксы расписания и «Построить»;
//   «Расчёт» — js-лямбды размера и даты начала работ
//     (см. lib/lambda.ts: (issue, activities) => …, с проверкой компиляции);
//   «Подключение» — URL, токен, проект.
import React, { useState } from "react";
import {
  Box, Button, Checkbox, CircularProgress, Divider, FormControlLabel,
  InputAdornment, Stack, Tab, Tabs, TextField, Tooltip,
} from "@mui/material";
import ReplayIcon from "@mui/icons-material/Replay";
import { parseIds, type AppSettings } from "../lib/constants";
import { compileSizeLambda, compileStartLambda } from "../lib/lambda";

const urlErr = (v: string): string =>
  (v && v.trim() !== "" && !v.trim().startsWith("http") ? "URL должен начинаться с http(s)://" : "");

interface Props {
  settings: AppSettings;
  setSettings: (patch: Partial<AppSettings>) => void;
  linkTypeOptions: string[];
  loaded: boolean;
  onLoad: () => void;
  onBuild: () => void;
  busy: boolean;
  // лямбды расчёта: тексты и колбэки изменения (текст + сохранить в localStorage)
  sizeLambda: string;
  startLambda: string;
  onSizeLambdaChange: (code: string) => void;
  onStartLambdaChange: (code: string) => void;
  onSizeLambdaReset: () => void;
  onStartLambdaReset: () => void;
}

export default function SettingsForm({
  settings, setSettings, linkTypeOptions, loaded, onLoad, onBuild, busy,
  sizeLambda, startLambda, onSizeLambdaChange, onStartLambdaChange,
  onSizeLambdaReset, onStartLambdaReset,
}: Props): React.ReactElement {
  const set = (patch: Partial<AppSettings>): void => setSettings(patch);
  const f = (key: keyof AppSettings) => (v: string): void => set({ [key]: v } as Partial<AppSettings>);

  // активный таб; по умолчанию — «Задачи»
  const [tab, setTab] = useState("issues");
  // инлайн-валидации появляются после первой попытки загрузки
  const [submitted, setSubmitted] = useState(false);

  const baseUrl = settings.baseUrl.trim();
  const errBaseUrl = submitted && !baseUrl ? "Укажите URL YouTrack"
    : submitted && urlErr(settings.baseUrl) ? urlErr(settings.baseUrl) : "";
  const errToken = submitted && !settings.token.trim() ? "Укажите permanent token" : "";
  const errIds = submitted && !parseIds(settings.ids).length ? "Не распознан ни один идентификатор" : "";

  // лямбды проверяются на каждый ввод: ошибка компиляции — под полем
  const sizeErr = compileSizeLambda(sizeLambda).error;
  const startErr = compileStartLambda(startLambda).error;
  // пустая связь отображается как «— только указанные тикеты —»
  const NO_LINK = "— только указанные тикеты —";

  const load = (): void => {
    setSubmitted(true);
    onLoad();
  };

  return (
    <Box className="panel" sx={{ position: "relative" }}>
      {/* индикатор занятости: форма при этом не блокируется визуально */}
      {busy && (
        <CircularProgress size={28} sx={{ position: "absolute", top: 16, right: 24, zIndex: 1 }} />
      )}
      <Tabs value={tab} onChange={(_, v: string) => setTab(v)}>
        {/* таб «Задачи» — первый и открыт по умолчанию */}
        <Tab value="issues" label="Задачи" />
        {/* таб «Расчёт» — лямбды размера и начала работ */}
        <Tab value="calc" label="Расчёт" />
        {/* таб «Подключение» — третий в списке */}
        <Tab value="connection" label="Подключение" />
      </Tabs>

      {tab === "issues" && (
        <Stack spacing={3} sx={{ pt: 2 }}>
          <Stack direction="row" spacing={2} sx={{ alignItems: "flex-end" }}>
            <TextField
              id="ids" label="Идентификаторы issue (через пробел, запятую или с новой строки; можно номера без префикса)"
              multiline rows={3} fullWidth
              value={settings.ids} onChange={(e) => f("ids")(e.target.value)}
              placeholder="101, 102&#10;103"
              error={!!errIds} helperText={errIds}
            />
            <Button variant="contained" onClick={load} disabled={busy} sx={{ mb: 0.5, whiteSpace: "nowrap" }}>
              Загрузить задачи
            </Button>
          </Stack>

          {/* тип связи и параметры расписания + «Построить» */}
          <fieldset className="group" disabled={!loaded}>
            <div className="group-title">
              Построение{loaded ? "" : " (сначала загрузите задачи)"}
            </div>
            <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
              <Tooltip title="Имя связи, под которым дети видны на тикете (для стандартной иерархии — parent for); пусто — только указанные тикеты">
                <TextField id="linkType" size="small" sx={{ width: 220 }}
                  label="Тип связи дочерних"
                  value={settings.linkType}
                  onChange={(e) => f("linkType")(e.target.value)}
                  placeholder={NO_LINK}
                  slotProps={{
                    input: { startAdornment: <InputAdornment position="start">↳</InputAdornment> },
                  }} />
              </Tooltip>
              <FormControlLabel control={
                <Checkbox size="small" checked={settings.skipWeekends}
                          onChange={(e) => set({ skipWeekends: e.target.checked })} />
              } label="пропускать выходные" />
              <FormControlLabel control={
                <Checkbox size="small" checked={settings.startToday}
                          onChange={(e) => set({ startToday: e.target.checked })} />
              } label="начинать сегодня (иначе — с понедельника текущей недели)" />
              <Button variant="contained" onClick={onBuild} disabled={busy || !loaded}>
                Построить
              </Button>
            </Stack>
          </fieldset>
        </Stack>
      )}

      {tab === "calc" && (
        <Stack spacing={3} sx={{ pt: 2 }}>
          <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: "flex-start", flexWrap: "wrap" }}>
            <TextField
              id="sizeLambda" label="Размер (дни)" multiline minRows={6} maxRows={20} fullWidth
              value={sizeLambda} onChange={(e) => onSizeLambdaChange(e.target.value)}
              error={!!sizeErr} helperText={sizeErr ?? "(issue, activities) ⇒ целое число дней — плановая длительность задачи"}
              slotProps={{
                input: {
                  endAdornment: (
                    <InputAdornment position="end">
                      <Tooltip title="Вернуть лямбду по умолчанию (Size → дни)">
                        <Button size="small" aria-label="Сбросить лямбду размера"
                                onClick={onSizeLambdaReset} startIcon={<ReplayIcon fontSize="small" />}>
                          сброс
                        </Button>
                      </Tooltip>
                    </InputAdornment>
                  ),
                  sx: { fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace", fontSize: 13 },
                },
              }} />
          </Stack>
          <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: "flex-start", flexWrap: "wrap" }}>
            <TextField
              id="startLambda" label="Начало работ" multiline minRows={6} maxRows={20} fullWidth
              value={startLambda} onChange={(e) => onStartLambdaChange(e.target.value)}
              error={!!startErr} helperText={startErr ?? "(issue, activities) ⇒ дата начала работ или null — фактическая дата начала работ"}
              slotProps={{
                input: {
                  endAdornment: (
                    <InputAdornment position="end">
                      <Tooltip title="Вернуть лямбду по умолчанию (переход в статус Doing)">
                        <Button size="small" aria-label="Сбросить лямбду начала работ"
                                onClick={onStartLambdaReset} startIcon={<ReplayIcon fontSize="small" />}>
                          сброс
                        </Button>
                      </Tooltip>
                    </InputAdornment>
                  ),
                  sx: { fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace", fontSize: 13 },
                },
              }} />
          </Stack>
          <Divider/>
          <div className="hint">
            Лямбды получают <code>issue</code> —{" "}
            {"{ id, summary, sizeRaw, resolved, resolvedAt, links, customFields }"} (customFields —
            словарь «имя поля → значение») и <code>activities</code> — историю изменений{" "}
            {"[{ ts, field, added[], removed[] }]"}. Размер должен вернуть число дней,
            начало работ — Date или null. Ошибки компиляции подсвечиваются; сломанная лямбда
            заменяется дефолтной, текст ошибки попадёт в предупреждения под диаграммой.
          </div>
        </Stack>
      )}

      {tab === "connection" && (
        <Stack direction="row" spacing={2} useFlexGap sx={{ pt: 2, alignItems: "flex-start", flexWrap: "wrap" }}>
          <TextField id="baseUrl" label="YouTrack URL" sx={{ width: 280 }}
            value={settings.baseUrl} onChange={(e) => f("baseUrl")(e.target.value)}
            placeholder="https://youtrack.example.com"
            error={!!errBaseUrl} helperText={errBaseUrl} />
          <TextField id="token" label="Permanent token" type="password" sx={{ width: 260 }}
            value={settings.token} onChange={(e) => f("token")(e.target.value)}
            placeholder="perm:…"
            error={!!errToken} helperText={errToken} />
          <TextField id="projectPrefix" label="Проект" sx={{ width: 120 }}
            value={settings.project} onChange={(e) => f("project")(e.target.value)}
            placeholder="напр. INFRA" />
        </Stack>
      )}
    </Box>
  );
}
