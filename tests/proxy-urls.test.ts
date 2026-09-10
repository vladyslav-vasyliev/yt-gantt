// Тесты прямых URL-веток (PROXY=false) и прокси-URL (PROXY=true через jsdom location).
// PROXY вычисляется при импорте модуля — для каждой ветки нужен отдельный файл
// с vi.hoisted-заглушкой location. Здесь: PROXY=false (нет location — node).
import { describe, it, expect, vi } from "vitest";

describe("PROXY=false (node без location): прямые запросы к YouTrack", () => {
  it("fetchIssue ходит на {base}/api/issues/{id} с Authorization", async () => {
    vi.doMock("../src/lib/youtrack", async (importOriginal) => {
      const m = await importOriginal<typeof import("../src/lib/youtrack")>();
      return m;
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      calls.push(url);
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ idReadable: "X-1", summary: "", resolved: null, customFields: [], links: [] }),
      } as Response);
    }));
    const { fetchIssue, PROXY } = await import("../src/lib/youtrack");
    expect(PROXY).toBe(false);
    await fetchIssue("https://yt.example.com/", "tok en", "X-1", "Size");
    expect(calls[0]).toBe("https://yt.example.com/api/issues/X-1?fields=" + encodeURIComponent(
      "idReadable,summary,resolved," +
      "customFields(name,value(name,localizedName)," +
      "projectCustomField(field(name),bundle(values(name,localizedName))))," +
      "links(linkType(name,sourceToTarget,targetToSource),direction,issues(idReadable))"));
    expect(calls[0]).not.toContain("__base=");
    vi.unstubAllGlobals();
  });

  it("fetchHistoryEvents: прямые URL, пагинация до короткой страницы", async () => {
    const calls: string[] = [];
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({
      timestamp: i, field: { customField: { name: "State" } }, added: [{ name: "S" }], removed: [],
    }));
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (!/activities/.test(url)) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response);
      calls.push(url);
      const skip = Number(new URL(url, "https://x").searchParams.get("$skip"));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mk(skip === 0 ? 100 : 1)) } as Response);
    }));
    const { fetchIssueHistory, PROXY } = await import("../src/lib/youtrack");
    expect(PROXY).toBe(false);
    const r = await fetchIssueHistory("https://yt.example.com", "tok", "X-1");
    expect(r.error).toBeNull();
    expect(r.history).toHaveLength(101);
    expect(calls[0]).toContain("https://yt.example.com/api/issues/X-1/activities?");
    expect(calls[0]).toContain("categories=CustomFieldCategory");
    expect(calls[0]).not.toContain("__base=");
    vi.unstubAllGlobals();
  });
});
