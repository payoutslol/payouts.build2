// Minimal static file server for Railway (no dependencies).
// Railway sets PORT; locally it falls back to 8080.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
// Only these get served; server/config files stay private.
const PUBLIC = new Set(["index.html", "styles.css", "app.js", "games.js"]);

http.createServer((req, res) => {
  let name;
  try { name = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, ""); }
  catch { res.writeHead(400); return res.end("Bad request"); }
  if (name === "") name = "index.html";
  if (!PUBLIC.has(name) && !name.startsWith("assets/")) name = "index.html";

  const file = path.join(ROOT, name);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": name === "index.html" ? "no-cache" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(data);
  });
}).listen(PORT, () => console.log(`payouts.build listening on port ${PORT}`));
