// Smoke-тесты server.cjs: crash-защита хендлера, SSRF-защита прокси, статика.
// Сервер запускается на случайном порту как дочерний процесс.
import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8493;
const BASE = `http://127.0.0.1:${PORT}`;

let child: ChildProcess | null = null;
let ready: Promise<void> | null = null;

function start(): Promise<void> {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    child = spawn(process.execPath, ["server.cjs"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: "ignore",
    });
    child.on("exit", (code) => reject(new Error(`server exited early: ${code}`)));
    const poll = async (left: number): Promise<void> => {
      try {
        const r = await fetch(`${BASE}/`);
        if (r.status === 200 || r.status === 404) resolve();
        else if (left > 0) setTimeout(() => void poll(left - 1), 100);
      } catch {
        if (left > 0) setTimeout(() => void poll(left - 1), 100);
        else reject(new Error("server did not start"));
      }
    };
    void poll(50);
  });
  return ready;
}

afterAll(() => { child?.kill(); });

describe("server.cjs", () => {
  it("статика раздаётся (dist/index.html)", async () => {
    await start();
    const r = await fetch(`${BASE}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
  });

  it("некорректный URL (/%\z) не роняет сервер — 400 и живой ответ дальше", async () => {
    await start();
    const bad = await fetch(`${BASE}/%`);
    expect(bad.status).toBe(400);
    // сервер остался жив
    const ok = await fetch(`${BASE}/`);
    expect(ok.status).toBe(200);
  });

  it("прокси отклоняет кросс-доменный Origin (SSRF-защита drive-by страниц)", async () => {
    await start();
    const r = await fetch(`${BASE}/yt/api/issues/X?__base=https://youtrack.example.com`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(r.status).toBe(403);
  });

  it("прокси без Origin работает: недоступный __base → 502 (пинтим только localhost)", async () => {
    await start();
    // 127.0.0.1:1 — закрытый порт: реальной сети нет, проверяем только релей
    const r = await fetch(`${BASE}/yt/api/issues/X?__base=http://127.0.0.1:1`);
    expect(r.status).toBe(502);
    expect(await r.text()).toContain("Proxy error");
  });

  it("__base без протокола отклоняется", async () => {
    await start();
    const r = await fetch(`${BASE}/yt/api/issues/X?__base=youtrack.example.com`);
    expect(r.status).toBe(400);
  });

  it("path traversal за пределы dist/ запрещён", async () => {
    await start();
    const r = await fetch(`${BASE}/../package.json`);
    // SPA-fallback может отдать index.html (404 внутри), но точно не файл за корнем
    const body = await r.text();
    expect(body).not.toContain('"name": "youtrack-gantt"');
  });
});
