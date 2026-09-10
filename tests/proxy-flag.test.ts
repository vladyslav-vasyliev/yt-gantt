// PROXY=true: location существует и протокол http(s) — отдельный импорт модуля
// с vi.hoisted-заглушкой location (PROXY вычисляется при первом импорте).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.stubGlobal("location", { protocol: "https:" });

describe("PROXY=true (location https): запросы через прокси-путь /yt", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("location", { protocol: "https:" });
  });

  it("fetchIssue и fetchIssueHistory ходят на /yt с __base", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      calls.push(url);
      if (/activities/.test(url)) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) } as Response);
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ idReadable: "X-1", summary: "", resolved: null, customFields: [], links: [] }),
      } as Response);
    }));
    const { fetchIssue, fetchIssueHistory, PROXY } = await import("../src/lib/youtrack");
    expect(PROXY).toBe(true);
    await fetchIssue("https://yt.example.com/", "tok", "X-1", "Size");
    await fetchIssueHistory("https://yt.example.com", "tok", "X-1");
    expect(calls[0]).toContain("/yt/api/issues/X-1?");
    expect(calls[0]).toContain(`__base=${encodeURIComponent("https://yt.example.com/")}`);
    expect(calls[1]).toContain("/yt/api/issues/X-1/activities?");
    expect(calls[1]).toContain(`__base=${encodeURIComponent("https://yt.example.com")}`);
    vi.unstubAllGlobals();
  });
});
