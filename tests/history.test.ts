import { afterEach, describe, expect, it, vi } from "vitest";
import { cache, collectMetaFromIssues, computeActualStart, fetchBatch, fetchIssueHistory } from "../src/lib/youtrack";
import type { Issue } from "../src/lib/constants";

const response = (data: unknown) => ({ ok: true, status: 200, json: async () => data } as Response);

afterEach(() => { vi.unstubAllGlobals(); cache.clear(); });

describe("custom-field activity history", () => {
  it("requests the documented category and field metadata, then reads subsequent pages", async () => {
    const first = {
      timestamp: 1788429600000,
      field: { name: "Custom field", customField: { name: "Workflow / Статус" } },
      added: { name: "Doing" }, removed: { name: "Open" },
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(Array.from({ length: 100 }, () => first)))
      .mockResolvedValueOnce(response([{ ...first, timestamp: 1788516000000, added: [{ name: "Done" }], removed: null }]));
    vi.stubGlobal("fetch", fetch);

    const result = await fetchIssueHistory("https://yt.example", "token", "INFRA-12575");
    expect(result.error).toBeNull();
    expect(result.history).toHaveLength(101);
    expect(result.history[0]).toEqual({
      ts: new Date(first.timestamp), field: "Workflow / Статус", added: ["Doing"], removed: ["Open"],
    });
    expect(result.history[100].added).toEqual(["Done"]);
    for (const [index, call] of fetch.mock.calls.entries()) {
      const url = new URL(call[0]);
      expect(url.pathname).toBe("/api/issues/INFRA-12575/activities");
      expect(url.searchParams.get("categories")).toBe("CustomFieldCategory");
      expect(url.searchParams.get("fields")).toContain("field(name,customField(name))");
      expect(url.searchParams.get("$top")).toBe("100");
      expect(url.searchParams.get("$skip")).toBe(String(index * 100));
      expect(url.searchParams.has("pageSize")).toBe(false);
    }
  });

  it("switching the UI field recalculates dates and options without mixing workflows", () => {
    const issue: Issue = {
      id: "INFRA-1", summary: "", sizeRaw: null, links: [], resolved: false,
      resolvedAt: null, _fieldValues: ["State", "Workflow / Статус"],
      _history: [
        { ts: new Date(1000), field: "State", added: ["Doing"], removed: ["Open"] },
        { ts: new Date(2000), field: "Workflow / Статус", added: ["Doing"], removed: ["Inbox"] },
        { ts: new Date(0), field: "", added: ["Doing"], removed: [] },
      ],
    };
    cache.set(issue.id, issue);
    expect(computeActualStart(issue, "State", "Doing")).toEqual(new Date(1000));
    expect(computeActualStart(issue, "Workflow / Статус", "Doing")).toEqual(new Date(2000));
    expect([...issue._statuses!]).toEqual(["Doing", "Inbox"]);
    expect(collectMetaFromIssues("State").statuses).toEqual(["Doing", "Open"]);
    expect(collectMetaFromIssues("Workflow / Статус").statuses).toEqual(["Doing", "Inbox"]);
    expect(computeActualStart(issue, "Unknown", "Doing")).toBeNull();
    expect([...issue._statuses!]).toEqual([]);
  });

  it.each([400, 404, 500])("reports HTTP %s without hiding errors behind fallback endpoints", async (status) => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status });
    vi.stubGlobal("fetch", fetch);
    const result = await fetchIssueHistory("https://yt.example", "token", "INFRA-1");
    expect(result.error).toContain(`HTTP ${status}`);
    expect(result.history).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("invalid JSON is reported through the same Toast callback as network errors", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response({ idReadable: "INFRA-1", customFields: [], links: [] }))
      .mockResolvedValueOnce({ ok: true, json: async () => { throw new Error("Invalid JSON"); } }));
    const onNetworkError = vi.fn();
    const problems: string[] = [];
    await fetchBatch(["INFRA-1"], { base: "https://yt.example", token: "token", sizeField: "Size", onNetworkError }, problems);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Invalid JSON");
    expect(onNetworkError).toHaveBeenCalledWith(problems[0]);
  });
});
