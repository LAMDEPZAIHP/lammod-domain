import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "domains.json");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_BODY = 8 * 1024;
const MAX_PER_IP_PER_MINUTE = 30;
const requests = new Map();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function send(res, status, data, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Cache-Control": "no-store"
  });
  res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
}

function getClientIp(req) {
  // Do not trust X-Forwarded-For unless configured behind a trusted proxy.
  return req.socket.remoteAddress || "unknown";
}

function rateLimit(req, res) {
  const now = Date.now();
  const ip = getClientIp(req);
  const entry = requests.get(ip) || { start: now, count: 0 };
  if (now - entry.start > 60_000) {
    entry.start = now;
    entry.count = 0;
  }
  entry.count++;
  requests.set(ip, entry);
  if (requests.size > 5000) {
    for (const [key, value] of requests) {
      if (now - value.start > 120_000) requests.delete(key);
    }
  }
  if (entry.count > MAX_PER_IP_PER_MINUTE) {
    send(res, 429, { error: "Quá nhiều yêu cầu. Hãy thử lại sau một phút." });
    return false;
  }
  return true;
}

async function readDomains() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === "ENOENT") {
      await fs.writeFile(DATA_FILE, "[]\n", "utf8");
      return [];
    }
    throw err;
  }
}

async function writeDomains(domains) {
  const tmp = DATA_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(domains, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, DATA_FILE);
}

function normalizeLabel(value) {
  if (typeof value !== "string") return null;
  const label = value.trim().toLowerCase();
  if (label.length < 3 || label.length > 30) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) return null;
  const reserved = new Set(["www", "api", "admin", "support", "help", "mail", "ftp", "localhost", "lammod"]);
  if (reserved.has(label)) return null;
  return label;
}

function validateDestination(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  let u;
  try {
    u = new URL(value.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  const hostname = u.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "0.0.0.0" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  ) return null;
  return u.toString();
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(PUBLIC, "." + decodeURIComponent(safePath));
  if (!filePath.startsWith(PUBLIC + path.sep)) {
    send(res, 403, { error: "Forbidden" });
    return;
  }
  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, body, MIME[ext] || "application/octet-stream");
  } catch {
    send(res, 404, { error: "Không tìm thấy trang." });
  }
}

const server = http.createServer(async (req, res) => {
  if (!rateLimit(req, res)) return;
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    send(res, 400, { error: "URL không hợp lệ." });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    send(res, 200, { ok: true, service: "LamMOD Domain", mode: "demo-local" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/domains") {
    try {
      const domains = await readDomains();
      send(res, 200, { domains: domains.map(({ name, destination, createdAt }) => ({ name, destination, createdAt })) });
    } catch {
      send(res, 500, { error: "Không đọc được dữ liệu." });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/domains") {
    let raw = "";
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > MAX_BODY) {
          send(res, 413, { error: "Dữ liệu quá lớn." });
          return;
        }
      }
      const body = JSON.parse(raw || "{}");
      const label = normalizeLabel(body.name);
      const destination = validateDestination(body.destination);
      if (!label) {
        send(res, 400, { error: "Tên phải dài 3–30 ký tự, chỉ gồm a-z, 0-9 và dấu gạch ngang ở giữa; một số tên bị dành riêng." });
        return;
      }
      if (!destination) {
        send(res, 400, { error: "URL đích không hợp lệ. Chỉ chấp nhận HTTP/HTTPS công khai, không có thông tin đăng nhập hoặc địa chỉ nội bộ." });
        return;
      }
      const domains = await readDomains();
      if (domains.some(d => d.name === label)) {
        send(res, 409, { error: "Tên này đã được đăng ký." });
        return;
      }
      if (domains.length >= 500) {
        send(res, 503, { error: "Bản demo đã đạt giới hạn 500 tên." });
        return;
      }
      const item = { name: label, destination, createdAt: new Date().toISOString() };
      domains.push(item);
      await writeDomains(domains);
      send(res, 201, { domain: `${label}.lammod`, ...item, resolverPath: `/r/${encodeURIComponent(label)}` });
    } catch {
      send(res, 400, { error: "JSON không hợp lệ." });
    }
    return;
  }

  const match = url.pathname.match(/^\/r\/([a-z0-9-]{3,30})$/);
  if (req.method === "GET" && match) {
    try {
      const label = match[1];
      const domains = await readDomains();
      const item = domains.find(d => d.name === label);
      if (!item) {
        send(res, 404, { error: `Không tìm thấy ${label}.lammod` });
        return;
      }
      const target = validateDestination(item.destination);
      if (!target) {
        send(res, 410, { error: "Đích đến không còn hợp lệ." });
        return;
      }
      // Render a confirmation page rather than silently redirecting arbitrary user URLs.
      const escapedTarget = target.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      const escapedName = `${label}.lammod`;
      const html = `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapedName} — LamMOD Domain</title><body style="font:16px system-ui;max-width:680px;margin:12vh auto;padding:24px;color:#f4f1ff;background:#11101a"><h1>LamMOD Domain</h1><p><b>${escapedName}</b> là tên miền thử nghiệm, không phải domain công khai.</p><p>Bạn sắp mở địa chỉ bên ngoài:</p><p style="overflow-wrap:anywhere">${escapedTarget}</p><p><a rel="noopener noreferrer nofollow" href="${escapedTarget}" style="display:inline-block;background:#9b7bff;color:#130d25;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700">Tiếp tục đến website</a></p><p style="color:#bcb6d1;font-size:13px">Chỉ tiếp tục nếu bạn tin tưởng website đích.</p></body></html>`;
      send(res, 200, html, "text/html; charset=utf-8");
    } catch {
      send(res, 500, { error: "Lỗi tra cứu." });
    }
    return;
  }

  if (req.method === "GET") {
    await serveStatic(req, res, url.pathname);
    return;
  }
  send(res, 405, { error: "Method Not Allowed" });
});

server.listen(PORT, HOST, () => {
  console.log(`LamMOD Domain chạy tại http://${HOST}:${PORT}`);
  console.log("Chế độ demo-local: không đưa trực tiếp lên Internet khi chưa bổ sung xác thực và lưu trữ phù hợp.");
});
