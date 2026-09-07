// «Doing» — эталон скриншот-теста сохранил yt_startstatus=Doing в localStorage? Нет — localStorage изолирован per-context.
// Но ЭТАЛОН-прогон юзера — реальный браузер! У него в localStorage старый yt_startstatus... 
// А в МОЁМ чистом плейрайт-браузере откуда 'Doing'? О! В предыдущих mock-* тестах я КЛИКАЛ по пунктам
// — нет, localStorage изолирован между запусками.
// 'Doing' до build... в SettingsForm startItems = withCurrent(statuses=[], 'In Progress') → ['In Progress'].
// Откуда Doing?? Единственный источник — localStorage. Но он пуст (только что проверено: getItem null ДО build).
// НО Combo value=... find(...) undefined → ComboBox сам показывает последний выбранный? Хм.
// Проверю проще: reload той же страницы (контекст сохранил? нет, тот же browser, но localStorage per origin —
// прошлые тесты в ЭТОМ контексте могли записать. В actF — свежий браузер... но я делал fill + build в actC/D/E
// — нет, каждый launch — новый контекст.
// Значит 'Doing' где-то в коде?! grep
