/* PDF editor — 100% local, no server, no upload.
   Rendering: pdf.js (v3 UMD).  Export: pdf-lib.
   Coordinates are stored normalized (0..1, top-left origin) per page so
   they survive zoom changes and map cleanly onto the exported PDF. */
(function () {
  "use strict";

  var pdfjsLib = window.pdfjsLib;
  var PDFLib = window.PDFLib;

  // pdf.js worker is injected by the build as a base64 blob (works on file://).
  if (window.__PDFJS_WORKER_BLOB_URL__) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = window.__PDFJS_WORKER_BLOB_URL__;
  }

  // ---------- State ----------
  var state = {
    bytes: null,          // Uint8Array of the original PDF (for export)
    fileName: "document.pdf",
    doc: null,            // pdf.js document
    pages: [],            // [{num, view, el, overlay, drawCanvas, drawCtx, wPt, hPt, rotate}]
    scale: 1.25,
    tool: "select",
    color: "#e23b3b",
    fontSize: 16,         // PDF points
    strokeWidth: 3,       // PDF points
    annos: [],            // see addAnno()
    selected: null,
    undoStack: ["[]"],
    redoStack: [],
    seq: 1
  };

  var dpr = window.devicePixelRatio || 1;

  // ---------- DOM ----------
  var $ = function (id) { return document.getElementById(id); };
  var stage = $("stage");
  var empty = $("empty");
  var fileInput = $("fileInput");

  // ---------- Helpers ----------
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove("show"); }, 2200);
  }
  function busy(on, label) {
    var b = $("busy");
    if (on) {
      b.innerHTML = '<span class="spinner"></span>' + (label || "Traitement…");
      b.classList.remove("hidden");
    } else {
      b.classList.add("hidden");
    }
  }
  function hexToRgb(hex) {
    var h = hex.replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return {
      r: parseInt(h.slice(0, 2), 16) / 255,
      g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255
    };
  }
  function uid() { return "a" + (state.seq++); }

  function commit() {
    state.undoStack.push(JSON.stringify(state.annos));
    if (state.undoStack.length > 100) state.undoStack.shift();
    state.redoStack = [];
    updateUndoButtons();
  }
  function restore(json) {
    state.annos = JSON.parse(json);
    state.selected = null;
    state.pages.forEach(function (p) { renderPageAnnos(p); });
    updateUndoButtons();
  }
  function undo() {
    if (state.undoStack.length <= 1) return;
    state.redoStack.push(state.undoStack.pop());
    restore(state.undoStack[state.undoStack.length - 1]);
  }
  function redo() {
    if (!state.redoStack.length) return;
    var s = state.redoStack.pop();
    state.undoStack.push(s);
    restore(s);
  }
  function updateUndoButtons() {
    $("undoBtn").disabled = state.undoStack.length <= 1;
    $("redoBtn").disabled = state.redoStack.length === 0;
  }

  // ---------- Load ----------
  function readFile(file) {
    if (!file) return;
    if (file.type && file.type.indexOf("pdf") === -1 &&
        !/\.pdf$/i.test(file.name)) {
      toast("Ce fichier n'est pas un PDF.");
      return;
    }
    state.fileName = file.name || "document.pdf";
    var fr = new FileReader();
    fr.onload = function () { openPdf(new Uint8Array(fr.result)); };
    fr.onerror = function () { toast("Lecture du fichier impossible."); };
    fr.readAsArrayBuffer(file);
  }

  function openPdf(bytes) {
    busy(true, "Ouverture du PDF…");
    state.bytes = bytes;
    state.annos = [];
    state.undoStack = ["[]"];
    state.redoStack = [];
    state.selected = null;
    // pdf.js transfers/detaches the buffer, so hand it a copy.
    var task = pdfjsLib.getDocument({ data: bytes.slice() });
    task.promise.then(function (doc) {
      state.doc = doc;
      buildPages().then(function () {
        empty.classList.add("hidden");
        $("exportBtn").disabled = false;
        $("clearBtn").disabled = false;
        updateUndoButtons();
        busy(false);
        toast(doc.numPages + " page(s) chargée(s).");
      });
    }).catch(function (e) {
      busy(false);
      console.error(e);
      toast("PDF illisible ou corrompu.");
    });
  }

  function buildPages() {
    stage.querySelectorAll(".page").forEach(function (n) { n.remove(); });
    state.pages = [];
    var chain = Promise.resolve();
    var list = [];
    for (var i = 1; i <= state.doc.numPages; i++) {
      (function (num) {
        chain = chain.then(function () {
          return state.doc.getPage(num).then(function (pdfPage) {
            var base = pdfPage.getViewport({ scale: 1 });
            var pageEl = document.createElement("div");
            pageEl.className = "page";
            pageEl.dataset.tool = state.tool;

            var pdfCanvas = document.createElement("canvas");
            pdfCanvas.className = "pdf";
            var overlay = document.createElement("div");
            overlay.className = "overlay";
            var drawCanvas = document.createElement("canvas");
            drawCanvas.className = "draw";

            pageEl.appendChild(pdfCanvas);
            pageEl.appendChild(overlay);
            overlay.appendChild(drawCanvas);
            stage.appendChild(pageEl);

            var P = {
              num: num,
              pdfPage: pdfPage,
              el: pageEl,
              canvas: pdfCanvas,
              overlay: overlay,
              drawCanvas: drawCanvas,
              drawCtx: drawCanvas.getContext("2d"),
              wPt: base.width,
              hPt: base.height,
              rotate: base.rotation || 0
            };
            state.pages.push(P);
            bindOverlay(P);
            list.push(P);
          });
        });
      })(i);
    }
    return chain.then(function () { return renderAll(); });
  }

  function renderAll() {
    var chain = Promise.resolve();
    state.pages.forEach(function (P) {
      chain = chain.then(function () { return renderPage(P); });
    });
    return chain;
  }

  function renderPage(P) {
    var vp = P.pdfPage.getViewport({ scale: state.scale });
    P.cssW = vp.width;
    P.cssH = vp.height;

    P.canvas.width = Math.floor(vp.width * dpr);
    P.canvas.height = Math.floor(vp.height * dpr);
    P.canvas.style.width = vp.width + "px";
    P.canvas.style.height = vp.height + "px";
    P.el.style.width = vp.width + "px";
    P.el.style.height = vp.height + "px";

    P.drawCanvas.width = Math.floor(vp.width * dpr);
    P.drawCanvas.height = Math.floor(vp.height * dpr);
    P.drawCanvas.style.width = vp.width + "px";
    P.drawCanvas.style.height = vp.height + "px";

    var ctx = P.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return P.pdfPage.render({ canvasContext: ctx, viewport: vp }).promise
      .then(function () {
        redrawStrokes(P);
        renderPageAnnos(P);
      });
  }

  // ---------- Annotations: model ----------
  function addAnno(a) {
    a.id = uid();
    state.annos.push(a);
    commit();
    return a;
  }
  function removeAnno(id) {
    state.annos = state.annos.filter(function (a) { return a.id !== id; });
    if (state.selected === id) state.selected = null;
    commit();
  }
  function annosFor(pageNum) {
    return state.annos.filter(function (a) { return a.page === pageNum; });
  }

  // ---------- Annotations: DOM rendering ----------
  function renderPageAnnos(P) {
    P.overlay.querySelectorAll(".anno").forEach(function (n) { n.remove(); });
    annosFor(P.num).forEach(function (a) {
      if (a.type === "text") P.overlay.appendChild(buildTextEl(P, a));
      else if (a.type === "check") P.overlay.appendChild(buildCheckEl(P, a));
    });
    redrawStrokes(P);
  }

  function delHandle(a) {
    var d = document.createElement("div");
    d.className = "del-handle";
    d.textContent = "×";
    d.title = "Supprimer";
    d.addEventListener("mousedown", function (e) {
      e.stopPropagation();
      e.preventDefault();
      removeAnno(a.id);
      var P = pageByNum(a.page);
      if (P) renderPageAnnos(P);
    });
    return d;
  }

  function buildTextEl(P, a) {
    var el = document.createElement("div");
    el.className = "anno text";
    el.dataset.id = a.id;
    el.style.left = (a.x * P.cssW) + "px";
    el.style.top = (a.y * P.cssH) + "px";
    el.style.color = a.color;
    el.style.fontSize = (a.size * state.scale) + "px";
    el.textContent = a.text || "";
    if (state.selected === a.id) el.classList.add("selected");
    el.appendChild(delHandle(a));

    enableDrag(el, P, a, function () {
      // double-click or text-tool click → edit
    });

    el.addEventListener("dblclick", function (e) {
      e.stopPropagation();
      startEditText(el, P, a);
    });
    el.addEventListener("blur", function () {
      el.contentEditable = "false";
      var txt = el.textContent.replace(/ /g, " ");
      if (!txt.trim()) {
        removeAnno(a.id);
        el.remove();
        return;
      }
      if (txt !== a.text) { a.text = txt; commit(); }
    });
    return el;
  }

  function startEditText(el, P, a) {
    select(a.id);
    el.contentEditable = "true";
    el.focus();
    var r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function buildCheckEl(P, a) {
    var el = document.createElement("div");
    el.className = "anno check";
    el.dataset.id = a.id;
    el.style.left = (a.x * P.cssW) + "px";
    el.style.top = (a.y * P.cssH) + "px";
    el.style.color = a.color;
    el.style.fontSize = (a.size * state.scale) + "px";
    el.textContent = a.mark === "cross" ? "✗" : "✔";
    if (state.selected === a.id) el.classList.add("selected");
    el.appendChild(delHandle(a));

    el.addEventListener("dblclick", function (e) {
      e.stopPropagation();
      a.mark = a.mark === "cross" ? "check" : "cross";
      el.firstChild.textContent = a.mark === "cross" ? "✗" : "✔";
      el.textContent = (a.mark === "cross" ? "✗" : "✔");
      el.appendChild(delHandle(a));
      if (state.selected === a.id) el.classList.add("selected");
      commit();
    });
    enableDrag(el, P, a);
    return el;
  }

  function select(id) {
    state.selected = id;
    document.querySelectorAll(".anno").forEach(function (n) {
      n.classList.toggle("selected", n.dataset.id === id);
    });
  }
  function deselect() {
    state.selected = null;
    document.querySelectorAll(".anno.selected")
      .forEach(function (n) { n.classList.remove("selected"); });
  }

  // ---------- Dragging ----------
  function enableDrag(el, P, a) {
    el.addEventListener("mousedown", function (e) {
      if (el.contentEditable === "true") return; // editing text
      e.stopPropagation();

      if (state.tool === "erase") {
        removeAnno(a.id);
        el.remove();
        return;
      }
      select(a.id);
      if (state.tool === "text" && a.type === "text") {
        startEditText(el, P, a);
        return;
      }
      if (state.tool !== "select") return;

      var rect = P.overlay.getBoundingClientRect();
      var startX = e.clientX, startY = e.clientY;
      var ox = a.x, oy = a.y;
      var moved = false;

      function mv(ev) {
        moved = true;
        var nx = ox + (ev.clientX - startX) / rect.width;
        var ny = oy + (ev.clientY - startY) / rect.height;
        a.x = Math.min(1, Math.max(0, nx));
        a.y = Math.min(1, Math.max(0, ny));
        el.style.left = (a.x * P.cssW) + "px";
        el.style.top = (a.y * P.cssH) + "px";
      }
      function up() {
        document.removeEventListener("mousemove", mv);
        document.removeEventListener("mouseup", up);
        if (moved) commit();
      }
      document.addEventListener("mousemove", mv);
      document.addEventListener("mouseup", up);
    });
  }

  // ---------- Freehand strokes ----------
  function redrawStrokes(P) {
    var ctx = P.drawCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, P.cssW, P.cssH);
    annosFor(P.num).forEach(function (a) {
      if (a.type !== "draw" || a.points.length < 1) return;
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width * state.scale;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      a.points.forEach(function (pt, i) {
        var x = pt.x * P.cssW, y = pt.y * P.cssH;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      if (a.points.length === 1) {
        var p0 = a.points[0];
        ctx.lineTo(p0.x * P.cssW + 0.1, p0.y * P.cssH + 0.1);
      }
      ctx.stroke();
    });
  }

  function bindOverlay(P) {
    P.overlay.addEventListener("mousedown", function (e) {
      // ignore clicks that landed on an annotation element
      if (e.target.closest && e.target.closest(".anno")) return;

      var rect = P.overlay.getBoundingClientRect();
      var nx = (e.clientX - rect.left) / rect.width;
      var ny = (e.clientY - rect.top) / rect.height;

      if (state.tool === "select") { deselect(); return; }

      if (state.tool === "text") {
        var a = addAnno({
          type: "text", page: P.num, x: nx, y: ny,
          size: state.fontSize, color: state.color, text: ""
        });
        var el = buildTextEl(P, a);
        P.overlay.appendChild(el);
        startEditText(el, P, a);
        return;
      }

      if (state.tool === "check") {
        var c = addAnno({
          type: "check", page: P.num, x: nx, y: ny,
          size: Math.max(14, state.fontSize), color: state.color,
          mark: "check"
        });
        P.overlay.appendChild(buildCheckEl(P, c));
        return;
      }

      if (state.tool === "erase") {
        eraseStrokeAt(P, nx, ny);
        return;
      }

      if (state.tool === "draw") {
        e.preventDefault();
        var stroke = {
          id: uid(), type: "draw", page: P.num,
          color: state.color, width: state.strokeWidth,
          points: [{ x: nx, y: ny }]
        };
        state.annos.push(stroke);
        var ctx = P.drawCtx;

        function mv(ev) {
          var x = (ev.clientX - rect.left) / rect.width;
          var y = (ev.clientY - rect.top) / rect.height;
          var prev = stroke.points[stroke.points.length - 1];
          stroke.points.push({ x: x, y: y });
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.strokeStyle = stroke.color;
          ctx.lineWidth = stroke.width * state.scale;
          ctx.lineJoin = "round";
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(prev.x * P.cssW, prev.y * P.cssH);
          ctx.lineTo(x * P.cssW, y * P.cssH);
          ctx.stroke();
        }
        function up() {
          document.removeEventListener("mousemove", mv);
          document.removeEventListener("mouseup", up);
          commit();
        }
        document.addEventListener("mousemove", mv);
        document.addEventListener("mouseup", up);
      }
    });
  }

  function eraseStrokeAt(P, nx, ny) {
    var tol = 0.012; // ~1.2% of page
    var hit = null;
    var strokes = annosFor(P.num).filter(function (a) { return a.type === "draw"; });
    for (var s = strokes.length - 1; s >= 0; s--) {
      var pts = strokes[s].points;
      for (var i = 0; i < pts.length; i++) {
        if (Math.abs(pts[i].x - nx) < tol && Math.abs(pts[i].y - ny) < tol) {
          hit = strokes[s].id; break;
        }
      }
      if (hit) break;
    }
    if (hit) {
      removeAnno(hit);
      redrawStrokes(P);
    }
  }

  function pageByNum(n) {
    for (var i = 0; i < state.pages.length; i++)
      if (state.pages[i].num === n) return state.pages[i];
    return null;
  }

  // ---------- Export ----------
  function rotateNorm(dx, dy, rot) {
    rot = ((rot % 360) + 360) % 360;
    if (rot === 90)  return { nx: dy, ny: 1 - dx };
    if (rot === 180) return { nx: 1 - dx, ny: 1 - dy };
    if (rot === 270) return { nx: 1 - dy, ny: dx };
    return { nx: dx, ny: dy };
  }

  function exportPdf() {
    if (!state.bytes) return;
    busy(true, "Génération du PDF…");
    var PDFDocument = PDFLib.PDFDocument;
    var rgb = PDFLib.rgb;
    var StandardFonts = PDFLib.StandardFonts;
    var LineCap = PDFLib.LineCapStyle;

    PDFDocument.load(state.bytes.slice()).then(function (out) {
      return out.embedFont(StandardFonts.Helvetica).then(function (font) {
        var pages = out.getPages();
        state.annos.forEach(function (a) {
          var page = pages[a.page - 1];
          if (!page) return;
          var size = page.getSize();
          var W = size.width, H = size.height;
          var rot = page.getRotation().angle || 0;
          var col = hexToRgb(a.color);
          var color = rgb(col.r, col.g, col.b);

          function pt(dx, dy) {
            var m = rotateNorm(dx, dy, rot);
            return { x: m.nx * W, y: H - m.ny * H };
          }

          if (a.type === "text") {
            var lines = (a.text || "").split("\n");
            var top = pt(a.x, a.y);
            var ascent = a.size * 0.8;
            lines.forEach(function (ln, i) {
              page.drawText(ln, {
                x: top.x,
                y: top.y - ascent - i * a.size * 1.2,
                size: a.size, font: font, color: color
              });
            });
          } else if (a.type === "check") {
            var s = a.size;
            var o = pt(a.x, a.y);            // top-left of the glyph box
            var th = Math.max(1.5, s * 0.12);
            if (a.mark === "cross") {
              page.drawLine({ start: { x: o.x + s * 0.15, y: o.y - s * 0.15 },
                              end:   { x: o.x + s * 0.85, y: o.y - s * 0.85 },
                              thickness: th, color: color, lineCap: LineCap.Round });
              page.drawLine({ start: { x: o.x + s * 0.85, y: o.y - s * 0.15 },
                              end:   { x: o.x + s * 0.15, y: o.y - s * 0.85 },
                              thickness: th, color: color, lineCap: LineCap.Round });
            } else {
              page.drawLine({ start: { x: o.x + s * 0.15, y: o.y - s * 0.55 },
                              end:   { x: o.x + s * 0.40, y: o.y - s * 0.80 },
                              thickness: th, color: color, lineCap: LineCap.Round });
              page.drawLine({ start: { x: o.x + s * 0.40, y: o.y - s * 0.80 },
                              end:   { x: o.x + s * 0.88, y: o.y - s * 0.18 },
                              thickness: th, color: color, lineCap: LineCap.Round });
            }
          } else if (a.type === "draw" && a.points.length > 1) {
            for (var i = 1; i < a.points.length; i++) {
              var p1 = pt(a.points[i - 1].x, a.points[i - 1].y);
              var p2 = pt(a.points[i].x, a.points[i].y);
              page.drawLine({
                start: p1, end: p2,
                thickness: a.width, color: color, lineCap: LineCap.Round
              });
            }
          }
        });
        return out.save();
      });
    }).then(function (bytes) {
      var blob = new Blob([bytes], { type: "application/pdf" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = state.fileName.replace(/\.pdf$/i, "") + "-edite.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      busy(false);
      toast("PDF exporté.");
    }).catch(function (e) {
      busy(false);
      console.error(e);
      toast("Échec de l'export : " + e.message);
    });
  }

  // ---------- Toolbar wiring ----------
  function setTool(name) {
    state.tool = name;
    document.querySelectorAll("button.tool").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tool === name);
    });
    state.pages.forEach(function (P) { P.el.dataset.tool = name; });
    if (name !== "select") deselect();
  }

  function setZoom(s) {
    state.scale = Math.min(4, Math.max(0.25, s));
    $("zoomLabel").textContent = Math.round(state.scale * 100) + "%";
    if (state.doc) renderAll();
  }

  function init() {
    document.querySelectorAll("button.tool").forEach(function (b) {
      b.addEventListener("click", function () { setTool(b.dataset.tool); });
    });

    $("openBtn").addEventListener("click", function () { fileInput.click(); });
    $("openBtn2").addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", function (e) {
      readFile(e.target.files[0]);
      fileInput.value = "";
    });

    var colorIn = $("colorIn");
    colorIn.value = state.color;
    colorIn.addEventListener("input", function () {
      state.color = colorIn.value;
      if (state.selected) {
        var a = state.annos.filter(function (x) { return x.id === state.selected; })[0];
        if (a) {
          a.color = state.color;
          var P = pageByNum(a.page);
          if (P) renderPageAnnos(P);
          commit();
        }
      }
    });

    var sw = $("strokeIn");
    sw.value = state.strokeWidth;
    $("strokeVal").textContent = state.strokeWidth;
    sw.addEventListener("input", function () {
      state.strokeWidth = +sw.value;
      $("strokeVal").textContent = sw.value;
    });

    var fs = $("fontIn");
    fs.value = state.fontSize;
    fs.addEventListener("change", function () {
      state.fontSize = +fs.value;
      if (state.selected) {
        var a = state.annos.filter(function (x) { return x.id === state.selected; })[0];
        if (a && (a.type === "text" || a.type === "check")) {
          a.size = state.fontSize;
          var P = pageByNum(a.page);
          if (P) renderPageAnnos(P);
          commit();
        }
      }
    });

    $("zoomIn").addEventListener("click", function () { setZoom(state.scale + 0.25); });
    $("zoomOut").addEventListener("click", function () { setZoom(state.scale - 0.25); });
    $("zoomReset").addEventListener("click", function () { setZoom(1.25); });

    $("undoBtn").addEventListener("click", undo);
    $("redoBtn").addEventListener("click", redo);
    $("exportBtn").addEventListener("click", exportPdf);
    $("clearBtn").addEventListener("click", function () {
      if (!state.annos.length) return;
      if (!confirm("Effacer toutes les annotations ?")) return;
      state.annos = [];
      state.selected = null;
      commit();
      state.pages.forEach(function (P) { renderPageAnnos(P); });
      toast("Annotations effacées.");
    });

    // drag & drop
    ["dragenter", "dragover"].forEach(function (ev) {
      empty.addEventListener(ev, function (e) {
        e.preventDefault(); empty.classList.add("drag");
      });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      empty.addEventListener(ev, function (e) {
        e.preventDefault(); empty.classList.remove("drag");
      });
    });
    empty.addEventListener("drop", function (e) {
      if (e.dataTransfer.files && e.dataTransfer.files[0])
        readFile(e.dataTransfer.files[0]);
    });
    window.addEventListener("dragover", function (e) { e.preventDefault(); });
    window.addEventListener("drop", function (e) {
      e.preventDefault();
      if (state.doc) return;
      if (e.dataTransfer.files && e.dataTransfer.files[0])
        readFile(e.dataTransfer.files[0]);
    });

    // keyboard
    document.addEventListener("keydown", function (e) {
      var editing = document.activeElement &&
        document.activeElement.isContentEditable;
      var meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault(); undo();
      } else if (meta && (e.key.toLowerCase() === "y" ||
                 (e.shiftKey && e.key.toLowerCase() === "z"))) {
        e.preventDefault(); redo();
      } else if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault(); if (state.doc) exportPdf();
      } else if ((e.key === "Delete" || e.key === "Backspace") &&
                 state.selected && !editing) {
        e.preventDefault();
        var id = state.selected;
        removeAnno(id);
        var a = null;
        state.pages.forEach(function (P) { renderPageAnnos(P); });
      } else if (e.key === "Escape") {
        if (editing) document.activeElement.blur();
        else deselect();
      }
    });

    setZoom(state.scale);
    updateUndoButtons();
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
