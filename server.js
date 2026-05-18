/* Minimal static file server (dev/preview only). */
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = process.env.PORT ? Number(process.env.PORT) : 4319;
const types = {
  ".html": "text/html", ".js": "text/javascript",
  ".css": "text/css", ".pdf": "application/pdf",
  ".json": "application/json"
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel === "/") rel = "/pdf-editor.html";
  const file = path.join(root, path.normalize(rel));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}).listen(port, () => console.log("static server on " + port));
