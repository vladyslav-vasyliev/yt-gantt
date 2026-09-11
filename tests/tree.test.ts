// Unit-тесты дерева связей и модели расписания «родитель-обёртка».
import { describe, it, expect } from "vitest";
import { childIdsOf, dfsOrder, schedule } from "../src/lib/tree";
import type { Issue } from "../src/lib/constants";

const mkIssue = (id: string, days: number | null, links: Issue["links"] = []): Issue => ({
  id, summary: "s-" + id, sizeRaw: null, links,
  resolved: false, resolvedAt: null, _fieldValues: [], days,
});

// конец бара длительностью days рабочих дней (как внутри schedule при skipWeekends)
const barEndLocal = (start: Date, days: number): Date => {
  const end = new Date(start);
  let left = days - 1;
  while (left > 0) {
    end.setDate(end.getDate() + 1);
    if (end.getDay() === 0 || end.getDay() === 6) continue;
    left--;
  }
  return end;
};

describe("childIdsOf", () => {
  const L = (dir: string, stt: string, tts: string, ids: string[]) => ({ dir, stt, tts, ids, name: stt });

  it("OUTBOUND long имя", () => {
    const it = mkIssue("R", 1, [L("OUTBOUND", "parent for", "subtask of", ["A-1"])]);
    expect(childIdsOf(it, "parent for", false)).toEqual(["A-1"]);
  });
  it("OUT short имя", () => {
    const it = mkIssue("R", 1, [L("OUT", "parent for", "subtask of", ["A-1"])]);
    expect(childIdsOf(it, "parent for", false)).toEqual(["A-1"]);
  });
  it("INBOUND long и IN short", () => {
    const a = mkIssue("R", 1, [L("INBOUND", "subtask of", "parent for", ["B-1"])]);
    const b = mkIssue("R", 1, [L("IN", "subtask of", "parent for", ["B-1"])]);
    expect(childIdsOf(a, "parent for", false)).toEqual(["B-1"]);
    expect(childIdsOf(b, "parent for", false)).toEqual(["B-1"]);
  });
  it("BOTH / недириктальный — по любому имени", () => {
    const it = mkIssue("R", 1, [L("BOTH", "parent for", "parent for", ["P-1"])]);
    expect(childIdsOf(it, "parent for", false)).toEqual(["P-1"]);
  });
  it("инверсия OUT — не матчится ни строго, ни мягко (иначе уйдём вверх по дереву)", () => {
    const it = mkIssue("R", 1, [L("OUTBOUND", "subtask of", "parent for", ["C-1"])]);
    expect(childIdsOf(it, "parent for", false)).toEqual([]);
    expect(childIdsOf(it, "parent for", true)).toEqual([]); // OUT-side tts игнорируем даже мягко
  });
  it("мягкий: IN-связь совпадает и по stt", () => {
    const it = mkIssue("R", 1, [L("INBOUND", "parent for", "subtask of", ["D-1"])]);
    expect(childIdsOf(it, "parent for", false)).toEqual([]);
    expect(childIdsOf(it, "parent for", true)).toEqual(["D-1"]);
  });
  it("пустой тип связи → пусто", () => {
    const it = mkIssue("R", 1, [L("OUT", "parent for", "subtask of", ["A-1"])]);
    expect(childIdsOf(it, "", false)).toEqual([]);
  });
  it("дедупликация детей", () => {
    const it = mkIssue("R", 1, [
      L("OUT", "parent for", "subtask of", ["A-1"]),
      L("IN", "subtask of", "parent for", ["A-1"]),
    ]);
    expect(childIdsOf(it, "parent for", false)).toEqual(["A-1"]);
  });
});

describe("dfsOrder", () => {
  it("дети строго под родителем; сироты в конец", () => {
    const R1 = mkIssue("R1", 1); R1.depth = 0; R1._kids = ["A1", "A2"];
    const A1 = mkIssue("A1", 1); A1.depth = 1;
    const A2 = mkIssue("A2", 1); A2.depth = 1; A2._kids = ["B1"];
    const B1 = mkIssue("B1", 1); B1.depth = 2;
    const R2 = mkIssue("R2", 1); R2.depth = 0;
    const orphan = mkIssue("X9", 1); orphan.depth = 3; // родитель не в выборке
    const ordered = dfsOrder([R1, A1, A2, B1, R2, orphan]);
    expect(ordered.map((i) => i.id)).toEqual(["R1", "A1", "A2", "B1", "R2", "X9"]);
  });
});

describe("schedule — модель «родитель-обёртка»", () => {
  // локальное время (не toISOString): schedule работает с локальными полуночами
  const f = (d: Date) => d.toLocaleDateString("sv-SE");
  const g = (issues: Issue[]) => Object.fromEntries(issues.map((i) => [i.id, { s: f(i.start!), e: f(i.end!) }]));

  it("трёхуровневое дерево: R1(A1(B1,B2),A2) + независимый R2", () => {
    const issues: Issue[] = [
      mkIssue("R1", 9), mkIssue("A1", 4), mkIssue("B1", 5), mkIssue("B2", 6), mkIssue("B3", 7), mkIssue("A2", 13), mkIssue("R2", 4),
    ];
    issues[0]._kids = ["A1", "A2"];
    issues[1]._kids = ["B1", "B2", "B3"];
    schedule(issues, true, true);
    const o = g(issues);
    // B1 стартует одновременно с A1 и R1 (от оси)
    expect(o.B1.s).toBe(o.A1.s);
    expect(o.R1.s).toBe(o.B1.s);
    // B2 после B1; B3 после B2; A1 — обёртка B1..B2..B3
    expect(o.B2.s > o.B1.e).toBe(true);
    expect(o.B3.s > o.B2.e).toBe(true);
    expect(o.A1.s).toBe(o.B1.s);
    expect(o.A1.e).toBe(o.B3.e);
    // A2 после A1; R1 — обёртка A1..A2
    expect(o.A2.s > o.A1.e).toBe(true);
    expect(o.R1.s).toBe(o.A1.s);
    expect(o.R1.e).toBe(o.A2.e);
    // R2 — независимый корень, от оси
    expect(o.R2.s).toBe(o.B1.s);
  });

  it("выходные пропускаются: бар X рабочих дней, конец — рабочий день", () => {
    const issues = [mkIssue("X", 3)];
    schedule(issues, true, true);
    // старт не раньше сегодня; длительность — ровно 3 рабочих дня (пн–пт),
    // поэтому конец — рабочий день, а календарная разница — 2..4 дня
    const today = new Date(); today.setHours(0, 0, 0, 0);
    expect(issues[0].start!.getTime()).toBeGreaterThanOrEqual(today.getTime());
    const end = issues[0].end!;
    expect([1, 2, 3, 4, 5]).toContain(end.getDay());
    const cal = Math.round((end.getTime() - issues[0].start!.getTime()) / 86400000) + 1;
    expect(cal).toBeGreaterThanOrEqual(3);
    expect(cal).toBeLessThanOrEqual(5); // 3 раб. дня ≤ 3 к.д. ≤ 3 раб. + 2 вых.
  });

  it("ось при startToday=false — понедельник недели или сегодня (что позже); при true — рабочий день", () => {
    const a = [mkIssue("A", 1)];
    schedule(a, true, false);
    // ось — понедельник недели, но задача не взята в работу и не может
    // начинаться раньше сегодня: если сегодня позже понедельника — старт сегодня
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const monday = new Date(today); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    expect([today.getTime(), monday.getTime()]).toContain(a[0].start!.getTime());
    const b = [mkIssue("B", 1)];
    schedule(b, true, true);
    expect([1, 2, 3, 4, 5]).toContain(b[0].start!.getDay());
  });

  it("без пропуска выходных: 7 дней = 7 календарных", () => {
    const issues = [mkIssue("Y", 7)];
    schedule(issues, false, true);
    const cal = Math.round((issues[0].end!.getTime() - issues[0].start!.getTime()) / 86400000) + 1;
    expect(cal).toBe(7);
  });

  it("цикл в связях не вешает расчёт", () => {
    const X = mkIssue("X", 2); const Y = mkIssue("Y", 2);
    X._kids = ["Y"]; Y._kids = ["X"];
    expect(() => schedule([X, Y], true, true)).not.toThrow();
    expect(X.start).toBeTruthy();
    expect(Y.start).toBeTruthy();
  });

  it("days <= 1 → бар в один день", () => {
    const issues = [mkIssue("Z", 0)];
    schedule(issues, true, true);
    expect(issues[0].start!.getTime()).toBe(issues[0].end!.getTime());
  });

  describe("факты (переход в статус начала / дата Resolved)", () => {
    it("незавершённая с фактом старта: бар от фактической даты + Size рабочих дней", () => {
      // 2026-08-10 — понедельник
      const a = mkIssue("A", 10);
      a.actualStart = new Date(2026, 7, 10);
      schedule([a], true, true);
      expect(f(a.start!)).toBe("2026-08-10");
      expect(f(a.end!)).toBe("2026-08-21"); // 10 рабочих дней: пн–пт × 2
    });

    it("завершённая с обоими фактами: бар ровно факт (даже если короче плана)", () => {
      const b = mkIssue("B", 10);
      b.actualStart = new Date(2026, 7, 10);
      b.resolved = true;
      b.resolvedAt = new Date(2026, 7, 14);
      b.actualEnd = b.resolvedAt;
      schedule([b], true, true);
      expect(f(b.start!)).toBe("2026-08-10");
      expect(f(b.end!)).toBe("2026-08-14");
    });

    it("только дата Resolved (истории начала нет): план Size уходит назад от resolvedAt", () => {
      const c = mkIssue("C", 5);
      c.resolved = true;
      c.resolvedAt = new Date(2026, 7, 14); // пятница
      c.actualEnd = c.resolvedAt;
      schedule([c], true, true);
      expect(f(c.end!)).toBe("2026-08-14");
      expect(f(c.start!)).toBe("2026-08-10"); // пн–пт
    });

    it("родитель-обёртка наследует факты детей: старт от первого ребёнка, конец — последнего", () => {
      const P = mkIssue("P", 10);
      const K = mkIssue("K", 3);
      P._kids = ["K"];
      K.actualStart = new Date(2026, 7, 3); // понедельник
      schedule([P, K], true, true);
      expect(f(P.start!)).toBe("2026-08-03");
      expect(f(P.end!)).toBe(f(K.end!));
    });

    it("родитель отсчитывается от дочерней, над которой раньше других начали работу", () => {
      // K1 идёт первым в списке и стартует по каскаду от оси (сентябрь),
      // но K2 имеет более ранний факт начала (август) — родитель стартует с него
      const P = mkIssue("P", 10);
      const K1 = mkIssue("K1", 2);
      const K2 = mkIssue("K2", 2);
      P._kids = ["K1", "K2"];
      K2.actualStart = new Date(2026, 7, 3); // 2026-08-03, понедельник
      schedule([P, K1, K2], true, true);
      expect(f(P.start!)).toBe("2026-08-03");
      // конец родителя — максимум по всем детям (K1 стартует позже от оси)
      const latest = f(K1.end!) >= f(K2.end!) ? f(K1.end!) : f(K2.end!);
      expect(f(P.end!)).toBe(latest);
    });

    it("завершение родителя — не раньше самой поздней даты завершения детей", () => {
      // K1 начата раньше и завершена раньше, K2 — позже; родитель (без
      // собственного факта конца) закрывается по последнему ребёнку
      const P = mkIssue("P", 10);
      const K1 = mkIssue("K1", 2);
      const K2 = mkIssue("K2", 2);
      P._kids = ["K1", "K2"];
      K1.actualStart = new Date(2026, 7, 3); // пн 2026-08-03
      K1.resolved = true;
      K1.actualEnd = new Date(2026, 7, 4);
      K2.actualStart = new Date(2026, 7, 10); // пн 2026-08-10
      K2.resolved = true;
      K2.actualEnd = new Date(2026, 7, 14);
      schedule([P, K1, K2], true, true);
      expect(f(P.start!)).toBe("2026-08-03"); // от самой ранней начатой
      expect(f(P.end!)).toBe("2026-08-14");   // до самой поздней завершённой
    });

    it("без размера план-конец родителя — максимум по всем потомкам, а не по последнему ребёнку", () => {
      // У родителя размер не задан → план = границы поддерева.
      // K1 завершена позже (20.09), K2 — последняя по порядку, но раньше (06.09):
      // раньше брался конец K2, и родитель «закрывался» 06.09 вместо 20.09
      const P = mkIssue("P", null);
      const K1 = mkIssue("K1", 2);
      const K2 = mkIssue("K2", 2);
      P._kids = ["K1", "K2"];
      K1.actualStart = new Date(2026, 8, 1);
      K1.resolved = true; K1.actualEnd = new Date(2026, 8, 20);
      K2.actualStart = new Date(2026, 8, 5);
      K2.resolved = true; K2.actualEnd = new Date(2026, 8, 6);
      schedule([P, K1, K2], true, true);
      expect(f(P.end!)).toBe("2026-09-20");     // не меньше позднего потомка
      expect(f(P.estEnd!)).toBe("2026-09-20");  // плановая дата завершения на графике
    });

    it("без размера план-конец родителя >= конца внука любого уровня вложенности", () => {
      // R → A → B; B завершается 30.09 — конец R тоже не раньше 30.09
      const R = mkIssue("R", null);
      const A = mkIssue("A", null);
      const B = mkIssue("B", 2);
      R._kids = ["A"]; A._kids = ["B"];
      B.actualStart = new Date(2026, 8, 1);
      B.resolved = true; B.actualEnd = new Date(2026, 8, 30);
      schedule([R, A, B], true, true);
      expect(f(A.end!)).toBe("2026-09-30");
      expect(f(R.end!)).toBe("2026-09-30");
      expect(f(R.estEnd!)).toBe("2026-09-30");
    });

    it("сценарий INFRA: родитель стартует от самого раннего начала среди себя и детей", () => {
      // Дерево: INFRA-1 → (INFRA-2, INFRA-3), INFRA-3 → (INFRA-4, INFRA-5).
      // Факты: Doing/Resolved заданы для всех тикетов.
      const I1 = mkIssue("INFRA-1", 3);
      const I2 = mkIssue("INFRA-2", 2);
      const I3 = mkIssue("INFRA-3", 5);
      const I4 = mkIssue("INFRA-4", 2);
      const I5 = mkIssue("INFRA-5", 3);
      I1._kids = ["INFRA-2", "INFRA-3"];
      I3._kids = ["INFRA-4", "INFRA-5"];
      const fact = (it: Issue, doing: string, resolved: string): void => {
        it.actualStart = new Date(doing);
        it.resolved = true;
        it.resolvedAt = new Date(resolved);
        it.actualEnd = it.resolvedAt;
      };
      fact(I1, "2026-09-08", "2026-09-11");
      fact(I2, "2026-09-07", "2026-09-09");
      fact(I3, "2026-09-08", "2026-09-15"); // свой Doing раньше, чем у детей
      fact(I4, "2026-09-09", "2026-09-10");
      fact(I5, "2026-09-14", "2026-09-18");

      schedule([I1, I2, I3, I4, I5], true, true);

      expect(g([I1, I2, I3, I4, I5])).toEqual({
        "INFRA-1": { s: "2026-09-07", e: "2026-09-18" },
        "INFRA-2": { s: "2026-09-07", e: "2026-09-09" },
        "INFRA-3": { s: "2026-09-08", e: "2026-09-18" },
        "INFRA-4": { s: "2026-09-09", e: "2026-09-10" },
        "INFRA-5": { s: "2026-09-14", e: "2026-09-18" },
      });
      // сплошной бар (факт) родителя-обёртки — агрегат по поддереву, а не
      // собственный Doing родителя (иначе INFRA-1 рисовался бы с 08.09)
      expect(f(I1.actualStart!)).toBe("2026-09-07");
      expect(f(I1.actualEnd!)).toBe("2026-09-18");
      expect(f(I3.actualStart!)).toBe("2026-09-08");
      expect(f(I3.actualEnd!)).toBe("2026-09-18");
    });

    it("правило «не раньше позднего ребёнка» сквозное: работает на всех уровнях", () => {
      // R -> A -> B -> C, 4 уровня: самый поздний конец — у глубокого внука C.
      // Сквозное правило: end(B) >= end(C), end(A) >= end(B) = end(C),
      // end(R) >= end(A) = end(C) — независимо от планов R и A (они длинные,
      // но заканчиваются раньше из-за ранних фактов своих детей).
      const R = mkIssue("R", 30);
      const A = mkIssue("A", 30);
      const B = mkIssue("B", 30);
      const C = mkIssue("C", 3);
      R._kids = ["A"]; A._kids = ["B"]; B._kids = ["C"];
      // C начата и завершена в августе; B/A/R без фактов
      C.actualStart = new Date(2026, 7, 10);
      C.resolved = true;
      C.actualEnd = new Date(2026, 7, 12);
      schedule([R, A, B, C], true, true);
      expect(f(C.end!)).toBe("2026-08-12");
      expect(f(B.end!)).toBe(f(C.end!));           // уровень 3
      expect(f(A.end!)).toBe(f(B.end!));           // уровень 2
      expect(f(R.end!)).toBe(f(A.end!));           // уровень 1 — сквозная передача
    });

    it("сквозность + собственный факт: максимум от позднего внука и своего факта", () => {
      // R(resolved 08-20) -> A -> B(C, конец 08-12): R закрывается по СВОЕМУ
      // факту 08-20, т.к. он позже позднего ребёнка A (08-12)
      const R = mkIssue("R", 30);
      const A = mkIssue("A", 10);
      const B = mkIssue("B", 10);
      const C = mkIssue("C", 3);
      R._kids = ["A"]; A._kids = ["B"]; B._kids = ["C"];
      C.actualStart = new Date(2026, 7, 10);
      C.resolved = true;
      C.actualEnd = new Date(2026, 7, 12);
      R.resolved = true;
      R.actualEnd = new Date(2026, 7, 20);
      schedule([R, A, B, C], true, true);
      expect(f(A.end!)).toBe("2026-08-12"); // A тянется до позднего C
      expect(f(R.end!)).toBe("2026-08-20"); // но не раньше собственного факта R
    });

    it("собственный факт конца родителя продлевает бар, если он позже детей", () => {
      const P = mkIssue("P", 10);
      const K = mkIssue("K", 2);
      P._kids = ["K"];
      K.actualStart = new Date(2026, 7, 3);
      K.resolved = true;
      K.actualEnd = new Date(2026, 7, 5);
      P.resolved = true;
      P.actualEnd = new Date(2026, 7, 12); // родитель закрыт позже ребёнка
      schedule([P, K], true, true);
      expect(f(P.start!)).toBe("2026-08-03");
      expect(f(P.end!)).toBe("2026-08-12"); // не раньше факта самого родителя
    });

  it("без факта — прежнее каскадное поведение от оси", () => {
    const d = mkIssue("D", 2);
    schedule([d], true, true);
    expect([1, 2, 3, 4, 5]).toContain(d.start!.getDay());
  });

  it("не взята в работа: план не раньше сегодня (якорь из каскада мог уйти в прошлое)", () => {
    // S — независимый корень без факта: пусть якорь оси и оказался в прошлом
    // (при startToday=false это понедельник недели) — клэмп уводит старт на сегодня
    const s = mkIssue("S", 2);
    schedule([s], true, false);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    expect(s.start!.getTime()).toBeGreaterThanOrEqual(today.getTime());
  });
  });

  describe("бар оценки (estStart/estEnd) параллельно факту", () => {
    it("без факта оценка совпадает с плановым баром", () => {
      const a = mkIssue("A", 3);
      schedule([a], true, true);
      expect(f(a.estStart!)).toBe(f(a.start!));
      expect(f(a.estEnd!)).toBe(f(a.end!));
    });

    it("незавершённая с фактом старта: оценка от фактического старта + Size рабочих дней", () => {
      // 2026-08-10 — понедельник
      const b = mkIssue("B", 5);
      b.actualStart = new Date(2026, 7, 10);
      schedule([b], true, true);
      expect(f(b.estStart!)).toBe("2026-08-10");
      expect(f(b.estEnd!)).toBe("2026-08-14"); // 5 рабочих дней
      expect(f(b.start!)).toBe("2026-08-10");
      expect(f(b.end!)).toBe("2026-08-14"); // план = оценке (не завершена)
    });

    it("завершённая: границы по факту, оценка может выходить за факт (недооценка видна)", () => {
      const c = mkIssue("C", 10);
      c.actualStart = new Date(2026, 7, 10);
      c.resolved = true;
      c.actualEnd = new Date(2026, 7, 14);
      schedule([c], true, true);
      expect(f(c.start!)).toBe("2026-08-10");
      expect(f(c.end!)).toBe("2026-08-14"); // факт
      expect(f(c.estStart!)).toBe("2026-08-10");
      expect(f(c.estEnd!)).toBe("2026-08-21"); // план Size: 10 рабочих дней
    });

    it("родитель-обёртка без размера: оценка = границам детей", () => {
      const P = mkIssue("P", null);
      const K = mkIssue("K", 2);
      P._kids = ["K"];
      schedule([P, K], true, true);
      expect(f(P.estStart!)).toBe(f(K.estStart!));
      expect(f(P.estEnd!)).toBe(f(K.estEnd!));
    });

    it("родитель с заданным размером: оценка = start + размер (даже меньше детей)", () => {
      const P = mkIssue("P", 2);
      const K = mkIssue("K", 20);
      P._kids = ["K"];
      schedule([P, K], true, true);
      // размер задан → плановый бар ровно 2 рабочих дня от старта, не границы детей
      expect(f(P.estStart!)).toBe(f(K.estStart!));
      expect(f(P.estEnd!)).not.toBe(f(K.estEnd!));
      expect(f(P.estEnd!)).toBe(f(barEndLocal(P.estStart!, 2)));
    });

    it("лист без размера: планового бара нет, для расписания 1 день", () => {
      const a = mkIssue("A", null);
      schedule([a], true, true);
      expect(a.estStart).toBeUndefined();
      expect(a.estEnd).toBeUndefined();
      // каскад: без размера задача занимает 1 день
      expect(a.end!.getTime()).toBe(a.start!.getTime());
    });
  });
});
