// Unit-тесты buildTreeAsync: BFS-обход, резолв корней, лимит, мягкий режим,
// циклы, сбои докачки.
import { describe, it, expect, vi } from "vitest";
import { buildTreeAsync, childIdsOf } from "../src/lib/tree";
import { MAX_ISSUES, type Issue, type LoadContext } from "../src/lib/constants";

const mkIssue = (id: string, kids: string[] = []): Issue => ({
  id, summary: "s-" + id, sizeRaw: null,
  links: kids.length ? [{ dir: "OUT", name: "Subtask", stt: "parent for", tts: "subtask of", ids: kids }] : [],
  resolved: false, resolvedAt: null, _fieldValues: [],
});

// ctx с кешем-заглушкой: fetchBatch кладёт детей в кеш (имитация докачки)
function mkCtx(cache: Map<string, Issue>, opts?: {
  failIds?: string[];            // эти id fetchBatch не кладёт (сеть/ошибка)
  onProgress?: (l: number, left: number) => void;
}) {
  const problems: string[] = [];
  const fail = new Set(opts?.failIds ?? []);
  const fetchBatch = async (ids: string[]): Promise<void> => {
    for (const id of ids) if (!fail.has(id)) cache.set(id.toUpperCase(), cache.get(id.toUpperCase()) ?? mkIssue(id));
  };
  return {
    ctx: { cache, fetchBatch: fetchBatch as unknown as TreeCtx["fetchBatch"], problems, onProgress: opts?.onProgress, loadCtx: {} },
    problems,
  };
}
type TreeCtx = Parameters<typeof buildTreeAsync>[2];

describe("buildTreeAsync — резолв корней", () => {
  it("корень без префикса («5») резолвится по кешу в INFRA-5", async () => {
    const cache = new Map<string, Issue>([["INFRA-5", mkIssue("INFRA-5")]]);
    const { ctx, problems } = mkCtx(cache);
    const r = await buildTreeAsync(["5"], "parent for", ctx);
    expect(problems).toHaveLength(0);
    expect(r.items.map((i) => i.id)).toEqual(["INFRA-5"]);
  });

  it("число с ведущими нулями («007») резолвится по суффиксу", async () => {
    const cache = new Map<string, Issue>([["INFRA-7", mkIssue("INFRA-7")]]);
    const { ctx } = mkCtx(cache);
    const r = await buildTreeAsync(["007"], "", ctx);
    expect(r.items.map((i) => i.id)).toEqual(["INFRA-7"]);
  });

  it("корень, которого нет в кеше, молча пропускается (и с суффиксом, и с дефисом)", async () => {
    const cache = new Map<string, Issue>([["A", mkIssue("A")]]);
    const { ctx } = mkCtx(cache);
    // «9» числовой, но в кеше только A (без суффикса 9) — не резолвится,
    // «MISSING-9» содержит дефис — без поиска по суффиксу
    const r = await buildTreeAsync(["A", "9", "MISSING-9"], "", ctx);
    expect(r.items.map((i) => i.id)).toEqual(["A"]);
  });

  it("пустой список корней — пустой результат", async () => {
    const { ctx } = mkCtx(new Map());
    const r = await buildTreeAsync([], "", ctx);
    expect(r.items).toEqual([]);
    expect(r.limitHit).toBe(false);
  });
});

describe("buildTreeAsync — обход и мягкий режим", () => {
  it("дети докачиваются уровнями; глубина проставляется", async () => {
    const cache = new Map<string, Issue>([["R", mkIssue("R", ["A", "B"])]]);
    const { ctx } = mkCtx(cache);
    const r = await buildTreeAsync(["R"], "parent for", ctx);
    expect(r.items.map((i) => [i.id, i.depth])).toEqual([["R", 0], ["A", 1], ["B", 1]]);
    expect(r.limitHit).toBe(false);
    expect(r.lenient).toBe(false);
  });

  it("внуки докачиваются на третьем уровне (fetchBatch вызывает onProgress)", async () => {
    const loaded = mkIssue("A", ["C"]);
    const cache = new Map<string, Issue>([["R", mkIssue("R", ["A"])]]);
    const onProgress = vi.fn();
    const problems: string[] = [];
    // заглушка fetchBatch: кладёт тикеты в кеш и вызывает progress, как youtrack.fetchBatch
    const fetchBatch = async (ids: string[]): Promise<void> => {
      for (const id of ids) {
        const up = id.toUpperCase();
        cache.set(up, up === "A" ? loaded : mkIssue(up));
      }
      if (onProgress) onProgress(cache.size, 0);
    };
    const ctx = {
      cache, fetchBatch: fetchBatch as unknown as TreeCtx["fetchBatch"],
      problems, onProgress, loadCtx: {},
    };
    const r = await buildTreeAsync(["R"], "parent for", ctx);
    expect(r.items.map((i) => i.id)).toEqual(["R", "A", "C"]);
    expect(onProgress).toHaveBeenCalled();
  });

  it("строгое сопоставление нашло детей — мягкий режим не включается", async () => {
    const cache = new Map<string, Issue>([["R", mkIssue("R", ["A"])]]);
    const { ctx, problems } = mkCtx(cache);
    const r = await buildTreeAsync(["R"], "parent for", ctx);
    expect(r.lenient).toBe(false);
    expect(problems).toHaveLength(0);
  });

  it("строгий режим не нашёл, мягкий нашёл → lenient=true и проблема", async () => {
    // IN-связь со «перевёрнутым» именем: строгий режим мимо, мягкий — совпадение по stt
    const R = mkIssue("R");
    R.links = [{ dir: "IN", name: "Subtask", stt: "parent for", tts: "subtask of", ids: ["A"] }];
    const cache = new Map<string, Issue>([["R", R]]);
    const { ctx, problems } = mkCtx(cache);
    const r = await buildTreeAsync(["R"], "parent for", ctx);
    expect(r.lenient).toBe(true);
    expect(problems[0]).toContain("мягкий режим");
    expect(r.items.map((i) => i.id)).toEqual(["R", "A"]);
  });

  it("ни строгий, ни мягкий не нашли детей — lenient=false, только корень", async () => {
    const cache = new Map<string, Issue>([["R", mkIssue("R", [])]]);
    const { ctx, problems } = mkCtx(cache);
    const r = await buildTreeAsync(["R"], "parent for", ctx);
    expect(r.lenient).toBe(false);
    expect(problems).toHaveLength(0);
    expect(r.items.map((i) => i.id)).toEqual(["R"]);
  });

  it("дубликаты детей (две связи на одного) не задваиваются", async () => {
    const R = mkIssue("R");
    R.links = [
      { dir: "OUT", name: "S", stt: "parent for", tts: "subtask of", ids: ["A"] },
      { dir: "OUT", name: "S2", stt: "parent for", tts: "subtask of", ids: ["A"] },
    ];
    const cache = new Map<string, Issue>([["R", R]]);
    const { ctx } = mkCtx(cache);
    const r = await buildTreeAsync(["R"], "parent for", ctx);
    expect(r.items.map((i) => i.id)).toEqual(["R", "A"]);
  });

  it("цикл в связях не уводит обход в бесконечность", async () => {
    const cache = new Map<string, Issue>([["X", mkIssue("X", ["Y"])], ["Y", mkIssue("Y", ["X"])]]);
    const { ctx } = mkCtx(cache);
    const r = await buildTreeAsync(["X"], "parent for", ctx);
    expect(r.items.map((i) => i.id)).toEqual(["X", "Y"]);
  });
});

describe("buildTreeAsync — лимит и сбои", () => {
  it("достигнут MAX_ISSUES: limitHit=true, обход прекращён", async () => {
    // корень с числом детей > MAX_ISSUES (текст проблемы пишет App, не tree)
    const many = Array.from({ length: MAX_ISSUES + 5 }, (_, i) => `K${i}`);
    const cache = new Map<string, Issue>([["R", mkIssue("R", many)]]);
    const { ctx } = mkCtx(cache);
    const r = await buildTreeAsync(["R"], "parent for", ctx);
    expect(r.limitHit).toBe(true);
    expect(r.items.length).toBeLessThanOrEqual(MAX_ISSUES);
  });

  it("ребёнок не скачался (сеть) — в дерево не попадает, обход продолжается", async () => {
    const cache = new Map<string, Issue>([["R", mkIssue("R", ["A", "B"])]]);
    const { ctx } = mkCtx(cache, { failIds: ["A"] });
    const r = await buildTreeAsync(["R"], "parent for", ctx);
    expect(r.items.map((i) => i.id)).toEqual(["R", "B"]);
  });

  it("fetchBatch без onProgress — прогресс не роняет", async () => {
    const cache = new Map<string, Issue>([["R", mkIssue("R", ["A"])]]);
    const { ctx } = mkCtx(cache); // onProgress === undefined
    const r = await buildTreeAsync(["R"], "parent for", ctx);
    expect(r.items.map((i) => i.id)).toEqual(["R", "A"]);
  });
});

// childIdsOf дублируется из tree.test.ts — здесь только ветка пустого S,
// но она уже покрыта; оставляем импорт использованным
describe("childIdsOf — null-безопасность", () => {
  it("issue без links → пусто", () => {
    const it = mkIssue("R");
    it.links = undefined as never;
    expect(childIdsOf(it, "parent for", true)).toEqual([]);
  });
});

// LoadContext используется только типом; импорт не должен быть мёртвым
type _LC = LoadContext;
