// Форма настроек на Material UI.
// ВАЖНО: setSettings из App — готовый апдейтер (patch → сохранение → state),
// вторично оборачивать его в setState нельзя — иначе ввод в поля не работает.
//
// Блок настроек разделён на табы:
//   «Задачи» (открывается по умолчанию) — идентификаторы + «Загрузить задачи»,
//     через Stack ниже — всё содержимое бывшего блока «Поля и построение»
//     (поля размера/статуса, статус начала и тип связи выбираются из значений
//     УЖЕ загруженных тикетов + «Построить», кнопка неактивна до загрузки);
//   «Подключение» — URL, токен, проект.
//
// Инлайн-валидации показываются после первой попытки «Загрузить задачи»
// (раньше за этим следил react-ui-validations).
import React, { useMemo, useState } from "react";
import {
  Autocomplete, Box, Button, Checkbox, CircularProgress, FormControlLabel,
  Stack, Tab, Tabs, TextField,
} from "@mui/material";
import { parseIds, withCurrent, type AppSettings } from "../lib/constants";

// элементы Autocomplete: объекты {value, label} (withCurrent даёт их сразу)
type Item = { value: string; label: string };

const urlErr = (v: string): string =>
  (v && v.trim() !== "" && !v.trim().startsWith("http") ? "URL должен начинаться с http(s)://" : "");

interface Props {
  settings: AppSettings;
  setSettings: (patch: Partial<AppSettings>) => void;
  linkTypeOptions: string[];
  fieldNames: string[];
  statuses: string[];
  loaded: boolean;
  onLoad: () => void;
  onBuild: () => void;
  busy: boolean;
}

export default function SettingsForm({ settings, setSettings, linkTypeOptions, fieldNames, statuses, loaded, onLoad, onBuild, busy }: Props): React.ReactElement {
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

  const sizeItems = useMemo(
    () => withCurrent(fieldNames, settings.sizeField, "Size"),
    [fieldNames, settings.sizeField]);
  const stateItems = useMemo(
    () => withCurrent(fieldNames, settings.stateField, "State"),
    [fieldNames, settings.stateField]);
  const statusItems = useMemo(
    () => withCurrent(statuses, settings.startStatus, "In Progress"),
    [statuses, settings.startStatus]);
  // пустая связь отображается как «— только указанные тикеты —»
  const NO_LINK = "— только указанные тикеты —";
  const linkItems = useMemo(
    () => [NO_LINK, ...linkTypeOptions].map((v) => ({ value: v === NO_LINK ? "" : v, label: v })),
    [linkTypeOptions]);

  // общие пропсы Autocomplete: элементы {value, label}, значение по value
  const comboProps = {
    size: "small" as const,
    getOptionLabel: (i: Item) => i.label,
    isOptionEqualToValue: (o: Item, v: Item) => o.value === v.value,
  };

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
        {/* таб «Подключение» — второй в списке */}
        <Tab value="connection" label="Подключение" />
      </Tabs>

      {tab === "issues" && (
        /* идентификаторы с кнопкой загрузки отделены от полей построения (spacing) */
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

          {/* поля и статусы — из загруженных тикетов + «Построить» */}
          <fieldset className="group" disabled={!loaded}>
            {/* заголовок — обычным блоком: legend с границей fieldset налезает на поля */}
            <div className="group-title">
              Поля и построение{loaded ? "" : " (сначала загрузите задачи)"}
            </div>
            <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap" }}>
              <Autocomplete<Item> id="sizeField" {...comboProps} sx={{ width: 160 }}
                options={sizeItems}
                value={sizeItems.find((i) => i.value === settings.sizeField) ?? null}
                onChange={(_, v) => set({ sizeField: v?.value ?? "" })}
                renderInput={(p) => <TextField {...p} label="Поле размера" />} />
              <Autocomplete<Item> id="stateField" {...comboProps} sx={{ width: 160 }}
                options={stateItems}
                value={stateItems.find((i) => i.value === settings.stateField) ?? null}
                onChange={(_, v) => set({ stateField: v?.value ?? "" })}
                renderInput={(p) => <TextField {...p} label="Поле статуса" />} />
              <Autocomplete<Item> id="startStatus" {...comboProps} sx={{ width: 180 }}
                options={statusItems}
                value={statusItems.find((i) => i.value === settings.startStatus) ?? null}
                onChange={(_, v) => set({ startStatus: v?.value ?? "" })}
                renderInput={(p) => <TextField {...p} label="Статус начала работы" />} />
              <Autocomplete<Item> id="linkType" {...comboProps} sx={{ width: 200 }}
                options={linkItems}
                value={linkItems.find((i) => i.value === settings.linkType) ?? { value: settings.linkType, label: settings.linkType }}
                onChange={(_, v) => set({ linkType: v?.value ?? "" })}
                renderInput={(p) => <TextField {...p} label="Тип связи дочерних" />} />
            </Stack>
            <Stack direction="row" spacing={2} useFlexGap sx={{ mt: 2, alignItems: "center", flexWrap: "wrap" }}>
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
