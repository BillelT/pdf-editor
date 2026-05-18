/* Assembles every source + vendored library into ONE self-contained
   pdf-editor.html that works offline by double-click (file://). */
const fs = require("fs");
const path = require("path");

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

// String.replace mangles $ sequences in the replacement, so swap via split/join.
function inject(haystack, marker, payload) {
  if (haystack.indexOf(marker) === -1)
    throw new Error("Marker not found: " + marker);
  return haystack.split(marker).join(payload);
}

const template = read("src/template.html");
const styles  = read("src/styles.css");
const app     = read("src/app.js");
const pdflib  = read("vendor/pdf-lib.min.js");
const pdfjs   = read("vendor/pdfjs.min.js");
const workerB64 = fs.readFileSync(
  path.join(root, "vendor/pdfjs.worker.min.js")
).toString("base64");

let html = template;
html = inject(html, "/*__STYLES__*/", styles);
html = inject(html, "/*__PDFLIB__*/", pdflib);
html = inject(html, "/*__PDFJS__*/", pdfjs);
html = inject(html, "/*__WORKER_B64__*/", workerB64);
html = inject(html, "/*__APP__*/", app);

const out = path.join(root, "pdf-editor.html");
fs.writeFileSync(out, html);

const kb = (fs.statSync(out).size / 1024).toFixed(0);
console.log("Built pdf-editor.html (" + kb + " KB)");
