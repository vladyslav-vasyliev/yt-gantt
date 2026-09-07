#!/usr/bin/env node
// YouTrack Gantt — статика собранного React-приложения (vite build → dist/)
// + прокси /yt → YouTrack (обход CORS). Без зависимостей.
//
//   node server.js                 → http://localhost:8414 (раздаёт dist/)
//   npm run build                  → собрать фронт перед запуском
//   npm run dev                    → Vite dev-сервер на :5173 (проксирует /yt сюда)
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 8414;
const ROOT = path.join(__dirname, "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8", ...CORS });
  res.end(body);
}

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (e) {
    // ошибка в хендлере не должна ронять процесс (например, URIError на «/%»)
    send(res, 400, "Bad request: " + (e instanceof Error ? e.message : "malformed"));
  }
});

function handle(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }

  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // ---- прокси: /yt/api/...?__base=https://youtrack.example.com ---------------
  if (u.pathname.startsWith("/yt/")) {
    // прокси нужен только самому приложению, которое раздаётся этим же сервером.
    // Без этой проверки любая веб-страница могла бы через localhost:8414
    // зондировать внутреннюю сеть (SSRF): CORS-заголовки ответа разрешают чтение
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin))
      return send(res, 403, "Forbidden: cross-origin proxy use is not allowed");
    const base = (u.searchParams.get("__base") || "").replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base))
      return send(res, 400, "Bad proxy request: __base must be http(s) URL");
    const sp = new URLSearchParams(u.search);
    sp.delete("__base");
    const qs = sp.toString();
    const target = new URL(base + u.pathname.slice(3) + (qs ? "?" + qs : ""));

    const headers = {};
    for (const h of ["authorization", "accept", "content-type"])
      if (req.headers[h]) headers[h] = req.headers[h];

    const mod = target.protocol === "https:" ? https : http;
    const creq = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: req.method,
        headers,
      },
      (cres) => {
        res.writeHead(cres.statusCode || 502, {
          "Content-Type": cres.headers["content-type"] || "application/json",
          ...CORS,
        });
        cres.pipe(res);
      }
    );
    // зависший YouTrack не должен держать сокет вечно
    creq.setTimeout(30_000, () => {
      creq.destroy(new Error("timeout: YouTrack не ответил за 30 c"));
    });
    creq.on("error", (e) => send(res, 502, "Proxy error: " + e.message));
    req.pipe(creq);
    return;
  }

  // ---- статика из dist/ (SPA fallback на index.html) -------------------------
  let p = decodeURIComponent(u.pathname);
  if (p === "/") p = "/index.html";
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, "");
  let file = path.join(ROOT, p);
  // startsWith(ROOT) пропустил бы соседний каталог («/x/dist2» при ROOT=/x/dist)
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT)
    return send(res, 403, "Forbidden");
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA-роутинг: всё неизвестное — на index.html
      fs.readFile(path.join(ROOT, "index.html"), (e2, d2) => {
        if (e2) return send(res, 404, "Not found. Собери фронт: npm run build");
        send(res, 200, d2, "text/html; charset=utf-8");
      });
      return;
    }
    send(res, 200, data, MIME[path.extname(file)] || "application/octet-stream");
  });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`YouTrack Gantt: http://localhost:${PORT}  (dist/)`);
});
