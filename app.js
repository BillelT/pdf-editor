/* =============================================================================
   PDF Editor — logique principale
   ---------------------------------------------------------------------------
   - Outils : V (sélection), T (texte), P (stylo), E (gomme)
   - Annotations stockées par page dans `state.pages[i].annotations`
   - Export : composite canvas → image embarquée dans un nouveau PDF (pdf-lib)
============================================================================= */

(() => {

  // ---------- État global ------------------------------------------------

  const state = {
    mode: 'edit',        // 'edit' | 'merge' | 'compress'
    tool: 'select',
    pages: [],           // [{ width, height, scale, pdfPage?, annotations: [], el, overlay, svg, ctx }]
    selected: null,      // { pageIndex, annoId } | null
    mergeFiles: [],      // [{ id, name, bytes, pageCount, error }]
    compressFile: null,  // { name, bytes, sizeBytes, numPages, error } | null
    compressResult: null,// { bytes, sizeBytes } | null
    compressQuality: 'medium', // 'low' | 'medium' | 'high'
    history: [],         // undo stack — snapshots des annotations
    textStyle: {
      font: 'sans',
      size: 18,
      weight: 400,
      italic: false,
      color: '#1e1b22',
    },
    penStyle: {
      color: '#1e1b22',
      size: 3,
    },
    drawing: null,       // stroke en cours
    dragging: null,      // { annoId, pageIndex, startX, startY, origX, origY }
    editingId: null,     // id de la text-anno en édition
  };

  let idSeq = 1;
  const uid = () => `a${idSeq++}`;

  // Bytes du PDF actuellement chargé dans l'éditeur (null si page vierge).
  // Conservés pour pouvoir recopier les pages en vectoriel à l'export,
  // au lieu de repartir du rendu canvas basse résolution.
  let sourcePdfBytes = null;

  const $ = (id) => document.getElementById(id);

  // ---------- Init -------------------------------------------------------

  function init () {
    bindToolbar();
    bindHeader();
    bindShortcuts();
    bindPanels();
    bindCanvasZone();
    bindModeTabs();
    bindMergePanel();
    bindCompressPanel();
    updateUI();
  }

  // ---------- Mode (Éditeur / Fusion / Compresser) ------------------------

  function bindModeTabs () {
    document.querySelectorAll('#mode-tabs .tabs__item').forEach(btn => {
      btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });
    $('btn-merge-2')?.addEventListener('click', () => setMode('merge'));
  }

  function setMode (mode) {
    state.mode = mode;
    document.querySelectorAll('#mode-tabs .tabs__item').forEach(b => {
      b.classList.toggle('tabs__item--active', b.dataset.mode === mode);
    });
    $('view-edit').classList.toggle('is-hidden', mode !== 'edit');
    $('view-merge').classList.toggle('is-hidden', mode !== 'merge');
    $('view-compress').classList.toggle('is-hidden', mode !== 'compress');
  }

  // ---------- Toolbar ----------------------------------------------------

  function bindToolbar () {
    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });
  }

  function setTool (tool) {
    state.tool = tool;
    // Sortir d'édition de texte si on change d'outil
    if (state.editingId) commitEditing();
    if (tool !== 'select') deselect();

    document.querySelectorAll('.tool-btn').forEach(b => {
      b.classList.toggle('is-active', b.dataset.tool === tool);
    });
    ['select', 'text', 'pen', 'erase'].forEach(t => {
      $(`panel-${t}`).classList.toggle('is-hidden', t !== tool);
    });
    state.pages.forEach(p => {
      p.overlay.className = `page__overlay page__overlay--${tool}`;
    });
    $('status-tool').textContent = `Outil : ${toolLabel(tool)}`;
  }

  function toolLabel (t) {
    return { select: 'Sélection', text: 'Texte', pen: 'Stylo', erase: 'Gomme' }[t];
  }

  // ---------- Shortcuts --------------------------------------------------

  function bindShortcuts () {
    window.addEventListener('keydown', (e) => {
      // Ignorer si on est en train de taper du texte dans une zone éditable
      const t = e.target;
      const isTyping = t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        if (state.mode === 'edit') {
          e.preventDefault();
          undo();
        }
        return;
      }

      if (isTyping || state.mode !== 'edit') return;

      switch (e.key.toLowerCase()) {
        case 'v': setTool('select'); break;
        case 't': setTool('text');   break;
        case 'p': setTool('pen');    break;
        case 'e': setTool('erase');  break;
        case 'escape':
          if (state.editingId) commitEditing();
          else deselect();
          break;
        case 'delete':
        case 'backspace':
          if (state.selected) {
            e.preventDefault();
            deleteSelected();
          }
          break;
      }
    });
  }

  // ---------- Header (ouvrir / exporter / page blanche) ------------------

  function bindHeader () {
    $('btn-open').addEventListener('click', () => $('file-input').click());
    $('btn-open-2').addEventListener('click', () => $('file-input').click());
    $('btn-blank').addEventListener('click', () => loadBlankPage());
    $('btn-blank-2').addEventListener('click', () => loadBlankPage());
    $('btn-export').addEventListener('click', exportPDF);

    $('file-input').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await loadPDF(file);
      e.target.value = '';
    });
  }

  // ---------- Panels -----------------------------------------------------

  function bindPanels () {
    // TEXT
    $('text-font').addEventListener('change', e => {
      state.textStyle.font = e.target.value;
      applyToSelected({ font: e.target.value });
    });
    $('text-size').addEventListener('input', e => {
      state.textStyle.size = +e.target.value;
      $('text-size-val').textContent = e.target.value;
      applyToSelected({ size: +e.target.value });
    });
    $('text-weight').addEventListener('change', e => {
      state.textStyle.weight = +e.target.value;
      applyToSelected({ weight: +e.target.value });
    });
    $('text-italic').addEventListener('change', e => {
      state.textStyle.italic = e.target.checked;
      applyToSelected({ italic: e.target.checked });
    });
    $('text-color').addEventListener('input', e => {
      state.textStyle.color = e.target.value;
      applyToSelected({ color: e.target.value });
    });

    // PEN
    $('pen-size').addEventListener('input', e => {
      state.penStyle.size = +e.target.value;
      $('pen-size-val').textContent = e.target.value;
    });
    $('pen-color').addEventListener('input', e => {
      state.penStyle.color = e.target.value;
    });

    // Swatches
    document.querySelectorAll('.swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        const target = sw.dataset.target;
        const color = sw.dataset.color;
        $(target).value = color;
        $(target).dispatchEvent(new Event('input', { bubbles: true }));
      });
    });
  }

  function applyToSelected (patch) {
    if (!state.selected) return;
    const anno = getAnno(state.selected);
    if (!anno || anno.type !== 'text') return;
    Object.assign(anno, patch);
    renderTextAnno(state.pages[state.selected.pageIndex], anno);
  }

  // ---------- Canvas zone events ----------------------------------------

  function bindCanvasZone () {
    $('canvas-zone').addEventListener('mousedown', e => {
      // Click sur le fond (pas une page) → désélectionner
      if (e.target === $('canvas-zone') || e.target.id === 'pages') {
        if (state.editingId) commitEditing();
        deselect();
      }
    });
  }

  // ---------- Chargement de PDF ------------------------------------------

  async function loadPDF (file) {
    const ab = await file.arrayBuffer();
    await loadPDFFromBytes(ab);
  }

  async function loadPDFFromBytes (bytes) {
    await ensurePdfJsReady();
    // pdf.js "consomme" le buffer transféré au worker : on en garde une copie
    // intacte pour pouvoir recopier les pages en vectoriel à l'export.
    sourcePdfBytes = bytes.slice(0);
    const pdf = await window.pdfjsLib.getDocument({ data: bytes }).promise;

    resetPages();
    for (let i = 1; i <= pdf.numPages; i++) {
      const pdfPage = await pdf.getPage(i);
      await renderPage(pdfPage);
    }
    afterPagesLoaded();
  }

  async function loadBlankPage () {
    sourcePdfBytes = null;
    resetPages();
    await renderBlankPage();
    afterPagesLoaded();
  }

  function ensurePdfJsReady () {
    return new Promise(resolve => {
      if (window.pdfjsLib) return resolve();
      window.addEventListener('pdfjs-ready', resolve, { once: true });
    });
  }

  function resetPages () {
    state.pages.forEach(p => p.el.remove());
    state.pages = [];
    state.history = [];
    state.selected = null;
    state.editingId = null;
  }

  function afterPagesLoaded () {
    $('empty-state').classList.add('is-hidden');
    $('status-pages').textContent = `${state.pages.length} page${state.pages.length > 1 ? 's' : ''}`;
    setTool(state.tool);
  }

  // ---------- Fusion de PDF ------------------------------------------------

  function bindMergePanel () {
    $('btn-merge-add').addEventListener('click', () => $('merge-file-input').click());

    $('merge-file-input').addEventListener('change', async e => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      await addMergeFiles(files);
    });

    $('btn-merge-download').addEventListener('click', mergeAndDownload);
    $('btn-merge-open').addEventListener('click', mergeAndOpenInEditor);
  }

  async function addMergeFiles (files) {
    const entries = files.map(file => ({
      id: uid(),
      name: file.name,
      bytes: null,
      pageCount: null,
      error: null,
    }));
    state.mergeFiles.push(...entries);
    renderMergeList();

    await Promise.all(entries.map(async (entry, i) => {
      try {
        const bytes = await files[i].arrayBuffer();
        const { PDFDocument } = window.PDFLib;
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
        entry.bytes = bytes;
        entry.pageCount = doc.getPageCount();
      } catch (err) {
        entry.error = 'Fichier PDF invalide';
      }
      renderMergeList();
    }));
  }

  function moveMergeFile (id, dir) {
    const list = state.mergeFiles;
    const i = list.findIndex(f => f.id === id);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    renderMergeList();
  }

  function removeMergeFile (id) {
    state.mergeFiles = state.mergeFiles.filter(f => f.id !== id);
    renderMergeList();
  }

  function renderMergeList () {
    const list = $('merge-list');
    const hint = $('merge-empty-hint');
    const files = state.mergeFiles;

    hint.classList.toggle('is-hidden', files.length > 0);
    list.innerHTML = '';

    files.forEach((entry, i) => {
      const li = document.createElement('li');
      li.className = 'merge-item';
      const meta = entry.error
        ? `<span class="merge-item__meta is-error">${entry.error}</span>`
        : entry.pageCount === null
          ? `<span class="merge-item__meta">Analyse…</span>`
          : `<span class="merge-item__meta">${entry.pageCount} page${entry.pageCount > 1 ? 's' : ''}</span>`;

      li.innerHTML = `
        <span class="merge-item__index">${i + 1}</span>
        <span class="merge-item__info">
          <span class="merge-item__name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>
          ${meta}
        </span>
        <span class="merge-item__actions">
          <button class="merge-item__btn" data-action="up" title="Monter" ${i === 0 ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>
          </button>
          <button class="merge-item__btn" data-action="down" title="Descendre" ${i === files.length - 1 ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <button class="merge-item__btn" data-action="remove" title="Retirer">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
          </button>
        </span>
      `;
      li.querySelector('[data-action="up"]').addEventListener('click', () => moveMergeFile(entry.id, -1));
      li.querySelector('[data-action="down"]').addEventListener('click', () => moveMergeFile(entry.id, 1));
      li.querySelector('[data-action="remove"]').addEventListener('click', () => removeMergeFile(entry.id));
      list.appendChild(li);
    });

    const validCount = files.filter(f => f.bytes && !f.error).length;
    $('btn-merge-download').disabled = validCount < 2;
    $('btn-merge-open').disabled = validCount < 2;
  }

  function escapeHtml (s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  async function buildMergedPdf () {
    const { PDFDocument } = window.PDFLib;
    const merged = await PDFDocument.create();
    const validFiles = state.mergeFiles.filter(f => f.bytes && !f.error);
    for (const entry of validFiles) {
      const src = await PDFDocument.load(entry.bytes, { ignoreEncryption: true });
      const copied = await merged.copyPages(src, src.getPageIndices());
      copied.forEach(p => merged.addPage(p));
    }
    return merged.save();
  }

  async function mergeAndDownload () {
    $('btn-merge-download').disabled = true;
    $('btn-merge-download').textContent = 'Fusion…';
    try {
      const bytes = await buildMergedPdf();
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pdf-fusionne-${Date.now()}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('La fusion a échoué : ' + err.message);
    } finally {
      $('btn-merge-download').textContent = 'Fusionner & télécharger';
      renderMergeList();
    }
  }

  async function mergeAndOpenInEditor () {
    $('btn-merge-open').disabled = true;
    $('btn-merge-open').textContent = 'Fusion…';
    try {
      const bytes = await buildMergedPdf();
      await loadPDFFromBytes(bytes);
      setMode('edit');
    } catch (err) {
      alert('La fusion a échoué : ' + err.message);
    } finally {
      $('btn-merge-open').textContent = "Ouvrir dans l'éditeur";
      renderMergeList();
    }
  }

  // ---------- Compression de PDF ------------------------------------------

  const COMPRESS_PRESETS = {
    low:    { targetDpi: 96,  jpegQuality: 0.5  },
    medium: { targetDpi: 130, jpegQuality: 0.7  },
    high:   { targetDpi: 170, jpegQuality: 0.82 },
  };

  function bindCompressPanel () {
    $('btn-compress-choose').addEventListener('click', () => $('compress-file-input').click());

    $('compress-file-input').addEventListener('change', async e => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (file) await pickCompressFile(file);
    });

    document.querySelectorAll('#compress-quality-tabs .tabs__item').forEach(btn => {
      btn.addEventListener('click', () => {
        state.compressQuality = btn.dataset.quality;
        document.querySelectorAll('#compress-quality-tabs .tabs__item').forEach(b => {
          b.classList.toggle('tabs__item--active', b === btn);
        });
        state.compressResult = null;
        renderCompressInfo();
      });
    });

    $('btn-compress-download').addEventListener('click', compressAndDownload);
    $('btn-compress-open').addEventListener('click', compressAndOpenInEditor);
  }

  async function pickCompressFile (file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    state.compressFile = {
      name: file.name,
      bytes,
      sizeBytes: bytes.byteLength,
      numPages: null,
      error: null,
    };
    state.compressResult = null;
    renderCompressInfo();

    await ensurePdfJsReady();
    try {
      const pdf = await window.pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      state.compressFile.numPages = pdf.numPages;
    } catch (err) {
      state.compressFile.error = 'PDF illisible';
    }
    renderCompressInfo();
  }

  function renderCompressInfo () {
    const entry = state.compressFile;
    const hasFile = !!entry;

    $('compress-info').classList.toggle('is-hidden', !hasFile);
    $('compress-quality-section').classList.toggle('is-hidden', !hasFile);

    if (hasFile) {
      $('compress-file-name').textContent = entry.name;
      const parts = [];
      if (entry.error) {
        parts.push(entry.error);
      } else {
        parts.push(entry.numPages === null ? 'Analyse…' : `${entry.numPages} page${entry.numPages > 1 ? 's' : ''}`);
        parts.push(`<b>${formatBytes(entry.sizeBytes)}</b>`);
        if (state.compressResult) {
          const ratio = Math.round((1 - state.compressResult.sizeBytes / entry.sizeBytes) * 100);
          parts.push(`→ <b>${formatBytes(state.compressResult.sizeBytes)}</b>`);
          parts.push(ratio > 0
            ? `<span class="compress-card__saved">-${ratio} %</span>`
            : `<span class="compress-card__nogain">Pas de gain à ce niveau — essaie "Fichier minimal"</span>`);
        }
      }
      $('compress-file-sizes').innerHTML = parts.join(' · ');
    }

    const ready = hasFile && !entry.error && entry.numPages !== null;
    $('btn-compress-download').disabled = !ready;
    $('btn-compress-open').disabled = !ready;
  }

  function formatBytes (n) {
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
    return `${Math.round(n / 1024)} Ko`;
  }

  async function buildCompressedPdf () {
    await ensurePdfJsReady();
    const { targetDpi, jpegQuality } = COMPRESS_PRESETS[state.compressQuality];
    const scale = targetDpi / 72;

    const srcPdf = await window.pdfjsLib.getDocument({ data: state.compressFile.bytes.slice() }).promise;
    const { PDFDocument } = window.PDFLib;
    const outDoc = await PDFDocument.create();

    for (let i = 1; i <= srcPdf.numPages; i++) {
      const pdfPage = await srcPdf.getPage(i);
      const baseViewport = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pdfPage.render({ canvasContext: ctx, viewport }).promise;

      const jpegBytes = await new Promise(resolve => {
        canvas.toBlob(blob => blob.arrayBuffer().then(resolve), 'image/jpeg', jpegQuality);
      });
      const img = await outDoc.embedJpg(jpegBytes);
      const outPage = outDoc.addPage([baseViewport.width, baseViewport.height]);
      outPage.drawImage(img, { x: 0, y: 0, width: baseViewport.width, height: baseViewport.height });
    }

    return outDoc.save();
  }

  async function compressAndDownload () {
    $('btn-compress-download').disabled = true;
    $('btn-compress-download').textContent = 'Compression…';
    try {
      const bytes = await buildCompressedPdf();
      state.compressResult = { bytes, sizeBytes: bytes.byteLength };
      renderCompressInfo();

      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const base = state.compressFile.name.replace(/\.pdf$/i, '');
      a.download = `${base}-compresse.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('La compression a échoué : ' + err.message);
    } finally {
      $('btn-compress-download').textContent = 'Compresser & télécharger';
      renderCompressInfo();
    }
  }

  async function compressAndOpenInEditor () {
    $('btn-compress-open').disabled = true;
    $('btn-compress-open').textContent = 'Compression…';
    try {
      const bytes = await buildCompressedPdf();
      state.compressResult = { bytes, sizeBytes: bytes.byteLength };
      await loadPDFFromBytes(bytes);
      setMode('edit');
    } catch (err) {
      alert('La compression a échoué : ' + err.message);
    } finally {
      $('btn-compress-open').textContent = "Ouvrir dans l'éditeur";
      renderCompressInfo();
    }
  }

  async function renderPage (pdfPage) {
    const baseViewport = pdfPage.getViewport({ scale: 1 });
    const targetWidth = Math.min(840, baseViewport.width * 1.2);
    const scale = targetWidth / baseViewport.width;
    const viewport = pdfPage.getViewport({ scale });

    const pageEl = createPageEl(viewport.width, viewport.height);
    const canvas = pageEl.querySelector('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');

    await pdfPage.render({ canvasContext: ctx, viewport }).promise;

    state.pages.push({
      width: viewport.width,
      height: viewport.height,
      pdfWidth: baseViewport.width,
      pdfHeight: baseViewport.height,
      scale,
      pdfPage,
      annotations: [],
      el: pageEl,
      canvas,
      ctx,
      overlay: pageEl.querySelector('.page__overlay'),
      svg: pageEl.querySelector('.page__svg'),
    });
    bindPageEvents(state.pages.length - 1);
  }

  async function renderBlankPage () {
    const width = 794;   // A4 @ ~96dpi
    const height = 1123;
    const pageEl = createPageEl(width, height);
    const canvas = pageEl.querySelector('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    state.pages.push({
      width, height,
      pdfWidth: width,
      pdfHeight: height,
      scale: 1,
      pdfPage: null,
      annotations: [],
      el: pageEl,
      canvas,
      ctx,
      overlay: pageEl.querySelector('.page__overlay'),
      svg: pageEl.querySelector('.page__svg'),
    });
    bindPageEvents(state.pages.length - 1);
  }

  function createPageEl (w, h) {
    const el = document.createElement('div');
    el.className = 'page';
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.innerHTML = `
      <canvas class="page__canvas"></canvas>
      <svg class="page__svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"></svg>
      <div class="page__overlay page__overlay--select"></div>
    `;
    $('pages').appendChild(el);
    return el;
  }

  // ---------- Page events (mousedown/move/up sur overlay) ----------------

  function bindPageEvents (pageIndex) {
    const page = state.pages[pageIndex];
    const overlay = page.overlay;

    overlay.addEventListener('mousedown', e => onPageMouseDown(e, pageIndex));
  }

  function onPageMouseDown (e, pageIndex) {
    const page = state.pages[pageIndex];
    const { x, y } = pagePoint(e, page);

    if (state.editingId) commitEditing();

    if (state.tool === 'text') {
      pushHistory();
      const anno = createTextAnno(x, y);
      page.annotations.push(anno);
      renderTextAnno(page, anno);
      select(pageIndex, anno.id);
      startEditing(pageIndex, anno.id);
      e.preventDefault();
      return;
    }

    if (state.tool === 'pen') {
      pushHistory();
      const stroke = {
        id: uid(),
        type: 'stroke',
        points: [{ x, y }],
        color: state.penStyle.color,
        size: state.penStyle.size,
      };
      page.annotations.push(stroke);
      state.drawing = { pageIndex, strokeId: stroke.id };
      renderStroke(page, stroke);
      attachPenMoveHandlers();
      e.preventDefault();
      return;
    }

    if (state.tool === 'erase') {
      const target = findAnnoAtPoint(page, x, y);
      if (target) {
        pushHistory();
        removeAnno(pageIndex, target.id);
      }
      e.preventDefault();
      return;
    }

    if (state.tool === 'select') {
      // Si on a cliqué sur le fond (pas une annotation) → désélectionner
      if (e.target === overlay || e.target === page.svg) {
        deselect();
      }
    }
  }

  function attachPenMoveHandlers () {
    const onMove = (e) => {
      if (!state.drawing) return;
      const page = state.pages[state.drawing.pageIndex];
      const stroke = page.annotations.find(a => a.id === state.drawing.strokeId);
      if (!stroke) return;
      const { x, y } = pagePoint(e, page);
      stroke.points.push({ x, y });
      renderStroke(page, stroke);
    };
    const onUp = () => {
      state.drawing = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function pagePoint (e, page) {
    const rect = page.overlay.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (page.width / rect.width),
      y: (e.clientY - rect.top) * (page.height / rect.height),
    };
  }

  // ---------- Annotations : create / render / find -----------------------

  function createTextAnno (x, y) {
    const s = state.textStyle;
    return {
      id: uid(),
      type: 'text',
      x, y,
      width: 200,
      content: '',
      font: s.font,
      size: s.size,
      weight: s.weight,
      italic: s.italic,
      color: s.color,
    };
  }

  // Pas de poignées n/s : la hauteur de la zone de texte suit toujours le
  // contenu (comme un texte "auto height" dans Figma), seule la largeur
  // se choisit à la main.
  const RESIZE_HANDLES = ['nw', 'ne', 'w', 'e', 'sw', 'se'];
  const MIN_TEXT_WIDTH = 40; // px, en espace page (canvas)

  function renderTextAnno (page, anno) {
    let el = page.overlay.querySelector(`[data-id="${anno.id}"]`);
    let content;
    if (!el) {
      el = document.createElement('div');
      el.className = 'text-anno';
      el.dataset.id = anno.id;
      el.dataset.pageIndex = state.pages.indexOf(page);

      content = document.createElement('div');
      content.className = 'text-anno__content';
      el.appendChild(content);

      RESIZE_HANDLES.forEach(dir => {
        const handle = document.createElement('div');
        handle.className = `text-anno__handle text-anno__handle--${dir}`;
        handle.dataset.handle = dir;
        el.appendChild(handle);
      });

      page.overlay.appendChild(el);
      bindTextAnnoEvents(el, content);
    } else {
      content = el.querySelector('.text-anno__content');
    }

    el.style.left = `${anno.x / page.width * 100}%`;
    el.style.top = `${anno.y / page.height * 100}%`;
    el.style.width = `${anno.width / page.width * 100}%`;
    content.style.fontFamily = anno.font === 'serif' ? 'var(--font-serif)' : 'var(--font-sans)';
    content.style.fontSize = `${anno.size}px`;
    content.style.fontWeight = anno.weight;
    content.style.fontStyle = anno.italic ? 'italic' : 'normal';
    content.style.color = anno.color;

    if (state.editingId !== anno.id) {
      content.textContent = anno.content;
    }
    el.classList.toggle('is-selected', state.selected?.annoId === anno.id);
    el.classList.toggle('is-editing', state.editingId === anno.id);
  }

  function bindTextAnnoEvents (el, content) {
    let down = null;
    let resize = null;

    content.addEventListener('mousedown', e => {
      const pageIndex = +el.dataset.pageIndex;
      const annoId = el.dataset.id;

      if (state.tool === 'erase') {
        pushHistory();
        removeAnno(pageIndex, annoId);
        e.stopPropagation();
        return;
      }

      if (state.tool === 'text') {
        // Cliquer sur une textbox en mode T → l'éditer plutôt qu'en créer une autre
        select(pageIndex, annoId);
        startEditing(pageIndex, annoId);
        e.stopPropagation();
        e.preventDefault();
        return;
      }

      if (state.tool !== 'select') return;

      if (state.editingId === annoId) {
        // déjà en édition, laisser passer au contentEditable
        e.stopPropagation();
        return;
      }

      select(pageIndex, annoId);
      const page = state.pages[pageIndex];
      const anno = getAnno({ pageIndex, annoId });
      down = {
        startMx: e.clientX,
        startMy: e.clientY,
        origX: anno.x,
        origY: anno.y,
        moved: false,
        pageIndex,
        annoId,
        rect: page.overlay.getBoundingClientRect(),
        pageW: page.width,
        pageH: page.height,
      };
      e.stopPropagation();
      e.preventDefault();
    });

    content.addEventListener('dblclick', e => {
      if (state.tool !== 'select') return;
      const pageIndex = +el.dataset.pageIndex;
      const annoId = el.dataset.id;
      startEditing(pageIndex, annoId);
      e.stopPropagation();
    });

    // Poignées de redimensionnement — ne touchent que la largeur (comme un
    // texte "auto height" dans Figma) ; les poignées côté gauche déplacent
    // aussi x pour garder le bord droit fixe.
    el.querySelectorAll('.text-anno__handle').forEach(handle => {
      handle.addEventListener('mousedown', e => {
        if (state.tool !== 'select') return;
        const pageIndex = +el.dataset.pageIndex;
        const annoId = el.dataset.id;
        const page = state.pages[pageIndex];
        const anno = getAnno({ pageIndex, annoId });
        if (!anno) return;

        resize = {
          dir: handle.dataset.handle,
          startMx: e.clientX,
          origWidth: anno.width,
          origX: anno.x,
          moved: false,
          pageIndex,
          annoId,
          rect: page.overlay.getBoundingClientRect(),
          pageW: page.width,
        };
        e.stopPropagation();
        e.preventDefault();
      });
    });

    const onMove = (e) => {
      if (resize) {
        const dx = (e.clientX - resize.startMx) * (resize.pageW / resize.rect.width);
        if (!resize.moved && Math.abs(dx) > 1) {
          resize.moved = true;
          pushHistory();
        }
        if (!resize.moved) return;
        const anno = getAnno({ pageIndex: resize.pageIndex, annoId: resize.annoId });
        if (!anno) return;
        if (resize.dir.includes('w')) {
          const newWidth = clamp(resize.origWidth - dx, MIN_TEXT_WIDTH, resize.origX + resize.origWidth);
          anno.x = resize.origX + (resize.origWidth - newWidth);
          anno.width = newWidth;
        } else {
          anno.width = clamp(resize.origWidth + dx, MIN_TEXT_WIDTH, resize.pageW - resize.origX);
        }
        renderTextAnno(state.pages[resize.pageIndex], anno);
        return;
      }

      if (!down) return;
      const dx = (e.clientX - down.startMx) * (down.pageW / down.rect.width);
      const dy = (e.clientY - down.startMy) * (down.pageH / down.rect.height);
      if (!down.moved && Math.hypot(dx, dy) > 2) {
        down.moved = true;
        pushHistory();
      }
      if (!down.moved) return;
      const anno = getAnno({ pageIndex: down.pageIndex, annoId: down.annoId });
      anno.x = clamp(down.origX + dx, 0, down.pageW - 8);
      anno.y = clamp(down.origY + dy, 0, down.pageH - 8);
      renderTextAnno(state.pages[down.pageIndex], anno);
    };

    const onUp = () => {
      down = null;
      resize = null;
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function startEditing (pageIndex, annoId) {
    state.editingId = annoId;
    const page = state.pages[pageIndex];
    const el = page.overlay.querySelector(`[data-id="${annoId}"]`);
    if (!el) return;
    const content = el.querySelector('.text-anno__content');
    el.classList.add('is-editing');
    content.setAttribute('contenteditable', 'plaintext-only');
    content.focus();
    // Placer le curseur en fin de texte
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function commitEditing () {
    if (!state.editingId) return;
    const sel = state.selected;
    if (!sel) { state.editingId = null; return; }
    const page = state.pages[sel.pageIndex];
    const el = page.overlay.querySelector(`[data-id="${state.editingId}"]`);
    if (!el) { state.editingId = null; return; }
    const content = el.querySelector('.text-anno__content');
    const anno = getAnno(sel);
    if (anno) {
      anno.content = content.textContent;
    }
    el.classList.remove('is-editing');
    content.removeAttribute('contenteditable');
    state.editingId = null;

    // Si le texte est vide, supprimer la zone
    if (anno && !anno.content.trim()) {
      removeAnno(sel.pageIndex, anno.id);
    }
  }

  function renderStroke (page, stroke) {
    let path = page.svg.querySelector(`path[data-id="${stroke.id}"]`);
    if (!path) {
      path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.dataset.id = stroke.id;
      page.svg.appendChild(path);
      bindStrokeEvents(path, page);
    }
    path.setAttribute('d', smoothPath(stroke.points));
    path.setAttribute('stroke', stroke.color);
    path.setAttribute('stroke-width', stroke.size);
    path.classList.toggle('is-selected', state.selected?.annoId === stroke.id);
    if (state.selected?.annoId === stroke.id) {
      path.style.filter = 'drop-shadow(0 0 2px var(--color-primary-orange))';
    } else {
      path.style.filter = '';
    }
  }

  function bindStrokeEvents (path, page) {
    path.addEventListener('mousedown', e => {
      const pageIndex = state.pages.indexOf(page);
      const annoId = path.dataset.id;
      if (state.tool === 'erase') {
        pushHistory();
        removeAnno(pageIndex, annoId);
        e.stopPropagation();
        return;
      }
      if (state.tool === 'select') {
        select(pageIndex, annoId);
        e.stopPropagation();
      }
    });
  }

  function smoothPath (points) {
    if (points.length === 0) return '';
    if (points.length === 1) {
      const p = points[0];
      return `M ${p.x} ${p.y} L ${p.x + 0.1} ${p.y + 0.1}`;
    }
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      const p = points[i];
      const prev = points[i - 1];
      const mx = (p.x + prev.x) / 2;
      const my = (p.y + prev.y) / 2;
      d += ` Q ${prev.x} ${prev.y} ${mx} ${my}`;
    }
    const last = points[points.length - 1];
    d += ` L ${last.x} ${last.y}`;
    return d;
  }

  function findAnnoAtPoint (page, x, y) {
    // Vérifié dans l'ordre inverse (top-most first)
    for (let i = page.annotations.length - 1; i >= 0; i--) {
      const a = page.annotations[i];
      if (a.type === 'text') {
        const el = page.overlay.querySelector(`[data-id="${a.id}"]`);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const pageRect = page.overlay.getBoundingClientRect();
        const sx = pageRect.left + (x / page.width) * pageRect.width;
        const sy = pageRect.top + (y / page.height) * pageRect.height;
        if (sx >= rect.left && sx <= rect.right && sy >= rect.top && sy <= rect.bottom) {
          return a;
        }
      } else if (a.type === 'stroke') {
        // hit-test : minimum distance d'un point sur stroke + tolérance
        const tol = Math.max(a.size, 8);
        for (const p of a.points) {
          if (Math.hypot(p.x - x, p.y - y) < tol) return a;
        }
      }
    }
    return null;
  }

  function removeAnno (pageIndex, annoId) {
    const page = state.pages[pageIndex];
    const idx = page.annotations.findIndex(a => a.id === annoId);
    if (idx === -1) return;
    const anno = page.annotations[idx];
    page.annotations.splice(idx, 1);

    if (anno.type === 'text') {
      page.overlay.querySelector(`[data-id="${annoId}"]`)?.remove();
    } else if (anno.type === 'stroke') {
      page.svg.querySelector(`path[data-id="${annoId}"]`)?.remove();
    }
    if (state.selected?.annoId === annoId) deselect();
  }

  function select (pageIndex, annoId) {
    if (state.selected?.annoId === annoId) return;
    if (state.selected) {
      const prev = getAnno(state.selected);
      if (prev) refreshAnno(state.selected.pageIndex, prev);
    }
    state.selected = { pageIndex, annoId };
    const a = getAnno(state.selected);
    if (a) {
      refreshAnno(pageIndex, a);
      if (a.type === 'text') syncTextPanelFromAnno(a);
    }
    updateSelectedPanel();
  }

  function deselect () {
    if (!state.selected) return;
    const prev = getAnno(state.selected);
    const pi = state.selected.pageIndex;
    state.selected = null;
    if (prev) refreshAnno(pi, prev);
    updateSelectedPanel();
  }

  function deleteSelected () {
    if (!state.selected) return;
    pushHistory();
    const { pageIndex, annoId } = state.selected;
    removeAnno(pageIndex, annoId);
  }

  function refreshAnno (pageIndex, anno) {
    const page = state.pages[pageIndex];
    if (anno.type === 'text') renderTextAnno(page, anno);
    else if (anno.type === 'stroke') renderStroke(page, anno);
  }

  function getAnno (sel) {
    if (!sel) return null;
    return state.pages[sel.pageIndex]?.annotations.find(a => a.id === sel.annoId);
  }

  function syncTextPanelFromAnno (a) {
    $('text-font').value = a.font;
    $('text-size').value = a.size;
    $('text-size-val').textContent = a.size;
    $('text-weight').value = a.weight;
    $('text-italic').checked = a.italic;
    $('text-color').value = a.color;
  }

  function updateSelectedPanel () {
    const target = $('panel-selected');
    if (!state.selected) {
      target.innerHTML = '';
      return;
    }
    const a = getAnno(state.selected);
    if (!a) { target.innerHTML = ''; return; }
    if (a.type === 'text') {
      target.innerHTML = `
        <div class="panel__hint" style="color: var(--color-ink);">
          Zone de texte sélectionnée. <br/>Passe en outil <kbd>T</kbd> pour éditer ses paramètres, ou double-clique pour éditer le contenu.
        </div>`;
    } else if (a.type === 'stroke') {
      target.innerHTML = `
        <div class="panel__hint" style="color: var(--color-ink);">
          Tracé sélectionné — <kbd>⌫</kbd> pour supprimer.
        </div>`;
    }
  }

  // ---------- History (undo simple) ---------------------------------------

  function pushHistory () {
    // snapshot des annotations par page
    const snap = state.pages.map(p => deepClone(p.annotations));
    state.history.push(snap);
    if (state.history.length > 50) state.history.shift();
  }

  function undo () {
    if (state.history.length === 0) return;
    const snap = state.history.pop();
    if (state.editingId) {
      const el = document.querySelector(`.text-anno[data-id="${state.editingId}"]`);
      el?.classList.remove('is-editing');
      el?.querySelector('.text-anno__content')?.removeAttribute('contenteditable');
      state.editingId = null;
    }
    state.selected = null;
    snap.forEach((annos, i) => {
      const page = state.pages[i];
      if (!page) return;
      // Nettoyer les éléments
      page.overlay.querySelectorAll('.text-anno').forEach(el => el.remove());
      page.svg.innerHTML = '';
      page.annotations = annos;
      annos.forEach(a => {
        if (a.type === 'text') renderTextAnno(page, a);
        else if (a.type === 'stroke') renderStroke(page, a);
      });
    });
    updateSelectedPanel();
  }

  function deepClone (x) {
    return JSON.parse(JSON.stringify(x));
  }

  // ---------- Utilitaires -----------------------------------------------

  function clamp (v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function updateUI () {
    setTool(state.tool);
  }

  // ---------- Export PDF (pages recopiées en vectoriel + annotations natives) --
  //
  // Le contenu d'origine (texte, images, vecteurs du PDF source) est recopié
  // tel quel via pdf-lib (copyPages) au lieu d'être rasterisé sur un canvas
  // d'aperçu — c'est ce qui causait la perte de qualité après fusion/édition,
  // y compris sur les pages pivotées (/Rotate), gérées via pageTransform().
  // Les annotations (texte, tracés) sont dessinées en tant qu'objets PDF
  // natifs (drawText / drawLine), donc résolution-indépendantes elles aussi.

  async function exportPDF () {
    if (state.pages.length === 0) return;
    if (state.editingId) commitEditing();

    $('btn-export').disabled = true;
    $('btn-export').textContent = 'Export…';

    // Assure que les fonts Switzer / Zodiak sont chargées avant qu'un
    // éventuel repli canvas ne les utilise — sinon canvas tombe en
    // fallback système.
    try {
      await Promise.all([
        document.fonts.load('400 18px "Switzer"'),
        document.fonts.load('400 18px "Zodiak"'),
      ]);
      await document.fonts.ready;
    } catch {}

    try {
      const { PDFDocument } = window.PDFLib;
      const pdfDoc = await PDFDocument.create();
      const fontCache = {};

      let srcDoc = null;
      if (sourcePdfBytes) {
        try {
          srcDoc = await PDFDocument.load(sourcePdfBytes, { ignoreEncryption: true });
        } catch {
          srcDoc = null; // source illisible → repli raster page par page
        }
      }

      for (let i = 0; i < state.pages.length; i++) {
        const page = state.pages[i];

        if (srcDoc && i < srcDoc.getPageCount()) {
          const [copied] = await pdfDoc.copyPages(srcDoc, [i]);
          const pdfPage = pdfDoc.addPage(copied);
          try {
            await drawAnnotationsVector(pdfPage, page, pdfDoc, fontCache);
          } catch {
            // Ex : caractère non supporté par les fonts standard PDF →
            // repli raster pour cette page uniquement, le reste du document
            // garde son export vectoriel.
            pdfDoc.removePage(pdfDoc.getPageCount() - 1);
            await rasterizePageIntoDoc(pdfDoc, page);
          }
          continue;
        }

        // Page vierge (pas de PDF source) : page pdf-lib native, 100% vectorielle
        const pdfPage = pdfDoc.addPage([page.pdfWidth, page.pdfHeight]);
        try {
          await drawAnnotationsVector(pdfPage, page, pdfDoc, fontCache);
        } catch {
          pdfDoc.removePage(pdfDoc.getPageCount() - 1);
          await rasterizePageIntoDoc(pdfDoc, page);
        }
      }

      const bytes = await pdfDoc.save();
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pdf-editor-export-${Date.now()}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      $('btn-export').disabled = false;
      $('btn-export').textContent = 'Exporter';
    }
  }

  // ---------- Annotations vectorielles (dessinées directement dans le PDF) --

  function hexToRgb01 (hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '#000000');
    if (!m) return [0, 0, 0];
    return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
  }

  // Une page PDF a un contenu "brut" (raw, origine en bas à gauche, non
  // affecté par /Rotate) et un rendu "visuel" tel qu'affiché par le lecteur
  // (celui que voit pdf.js/le canvas d'édition, origine en haut à gauche).
  // Nos annotations sont créées en coordonnées visuelles (clic souris sur le
  // canvas) ; pour les dessiner dans le PDF il faut les reprojeter en
  // coordonnées brutes selon la rotation de la page. Vérifié empiriquement
  // (rendu pdf.js) pour les 4 valeurs possibles de /Rotate.
  function pageTransform (pdfPage, page) {
    const rot = ((pdfPage.getRotation().angle % 360) + 360) % 360;
    return { rot, rawWidth: pdfPage.getWidth(), rawHeight: pdfPage.getHeight(), scale: page.scale };
  }

  function visualToRaw (t, canvasX, canvasY) {
    const vx = canvasX / t.scale;
    const vy = canvasY / t.scale;
    switch (t.rot) {
      case 90: return { x: vy, y: vx };
      case 180: return { x: t.rawWidth - vx, y: vy };
      case 270: return { x: t.rawWidth - vy, y: t.rawHeight - vx };
      default: return { x: vx, y: t.rawHeight - vy };
    }
  }

  const STANDARD_FONT_VARIANTS = {
    sans: { regular: 'Helvetica', bold: 'HelveticaBold', italic: 'HelveticaOblique', boldItalic: 'HelveticaBoldOblique' },
    serif: { regular: 'TimesRoman', bold: 'TimesRomanBold', italic: 'TimesRomanItalic', boldItalic: 'TimesRomanBoldItalic' },
  };

  async function getStandardFont (pdfDoc, fontCache, family, weight, italic) {
    const bold = weight >= 600;
    const variant = bold && italic ? 'boldItalic' : bold ? 'bold' : italic ? 'italic' : 'regular';
    const key = STANDARD_FONT_VARIANTS[family === 'serif' ? 'serif' : 'sans'][variant];
    if (!fontCache[key]) {
      const { StandardFonts } = window.PDFLib;
      fontCache[key] = await pdfDoc.embedFont(StandardFonts[key]);
    }
    return fontCache[key];
  }

  function wrapTextForFont (font, text, maxWidthPt, fontSizePt) {
    const out = [];
    text.split('\n').forEach(paragraph => {
      const words = paragraph.split(' ');
      let line = '';
      for (const w of words) {
        const test = line ? `${line} ${w}` : w;
        if (font.widthOfTextAtSize(test, fontSizePt) > maxWidthPt && line) {
          out.push(line);
          line = w;
        } else {
          line = test;
        }
      }
      out.push(line);
    });
    return out;
  }

  async function drawTextVector (pdfPage, anno, page, pdfDoc, fontCache, t) {
    if (!anno.content) return;
    const { rgb, degrees } = window.PDFLib;
    const font = await getStandardFont(pdfDoc, fontCache, anno.font, anno.weight, anno.italic);
    const scale = t.scale;
    const fontSizePt = anno.size / scale;
    const maxWidthPt = anno.width / scale;
    const lineHeightCanvas = anno.size * 1.3;
    const ascentPt = font.heightAtSize(fontSizePt, { descender: false });
    const [r, g, b] = hexToRgb01(anno.color);

    const lines = wrapTextForFont(font, anno.content, maxWidthPt, fontSizePt);
    lines.forEach((line, i) => {
      if (!line) return;
      // Ligne de base en espace visuel (même formule que le rendu canvas :
      // padding 4px/2px + hauteur de ligne, cf. drawTextToCtx), reprojetée
      // en une seule fois vers l'espace brut de la page.
      const visualBaselineY = anno.y + 2 + i * lineHeightCanvas + ascentPt * scale;
      const raw = visualToRaw(t, anno.x + 4, visualBaselineY);
      pdfPage.drawText(line, {
        x: raw.x, y: raw.y,
        size: fontSizePt, font, color: rgb(r, g, b),
        rotate: degrees(t.rot),
      });
    });
  }

  function drawStrokeVector (pdfPage, stroke, t) {
    if (!stroke.points || stroke.points.length === 0) return;
    const { rgb, LineCapStyle } = window.PDFLib;
    const [r, g, b] = hexToRgb01(stroke.color);
    const toPt = (p) => visualToRaw(t, p.x, p.y);
    const thickness = Math.max(0.1, stroke.size / t.scale);
    const color = rgb(r, g, b);

    if (stroke.points.length === 1) {
      const p = toPt(stroke.points[0]);
      pdfPage.drawLine({ start: p, end: p, thickness, color, lineCap: LineCapStyle.Round });
      return;
    }
    for (let i = 1; i < stroke.points.length; i++) {
      pdfPage.drawLine({
        start: toPt(stroke.points[i - 1]),
        end: toPt(stroke.points[i]),
        thickness,
        color,
        lineCap: LineCapStyle.Round,
      });
    }
  }

  async function drawAnnotationsVector (pdfPage, page, pdfDoc, fontCache) {
    const t = pageTransform(pdfPage, page);
    for (const a of page.annotations) {
      if (a.type === 'stroke') drawStrokeVector(pdfPage, a, t);
    }
    for (const a of page.annotations) {
      if (a.type === 'text') await drawTextVector(pdfPage, a, page, pdfDoc, fontCache, t);
    }
  }

  // ---------- Repli raster (cas limite, ex. caractère non supporté) -------
  //
  // Historique : composite canvas (rendu PDF + strokes + textes) → PNG
  // embarqué dans une page pdf-lib. Perd en résolution ; ne sert plus que de
  // filet de sécurité si le dessin vectoriel d'une page échoue (ex. police
  // standard PDF ne supportant pas un caractère saisi), pour cette page
  // uniquement — le reste du document garde son export vectoriel.

  async function rasterizePageIntoDoc (pdfDoc, page) {
    const out = document.createElement('canvas');
    out.width = page.width;
    out.height = page.height;
    const ctx = out.getContext('2d');

    ctx.drawImage(page.canvas, 0, 0);
    for (const a of page.annotations) {
      if (a.type === 'stroke') drawStrokeToCtx(ctx, a);
    }
    for (const a of page.annotations) {
      if (a.type === 'text') drawTextToCtx(ctx, a);
    }

    const pngBytes = await new Promise(resolve => {
      out.toBlob(blob => blob.arrayBuffer().then(resolve), 'image/png');
    });
    const img = await pdfDoc.embedPng(pngBytes);
    const pdfPage = pdfDoc.addPage([page.pdfWidth, page.pdfHeight]);
    pdfPage.drawImage(img, { x: 0, y: 0, width: page.pdfWidth, height: page.pdfHeight });
  }

  function drawStrokeToCtx (ctx, stroke) {
    if (stroke.points.length === 0) return;
    ctx.save();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i++) {
      const p = stroke.points[i];
      const prev = stroke.points[i - 1];
      const mx = (p.x + prev.x) / 2;
      const my = (p.y + prev.y) / 2;
      ctx.quadraticCurveTo(prev.x, prev.y, mx, my);
    }
    const last = stroke.points[stroke.points.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
    ctx.restore();
  }

  function drawTextToCtx (ctx, anno) {
    ctx.save();
    const family = anno.font === 'serif'
      ? "'Zodiak', Georgia, serif"
      : "'Switzer', system-ui, sans-serif";
    const style = anno.italic ? 'italic' : 'normal';
    ctx.font = `${style} ${anno.weight} ${anno.size}px ${family}`;
    ctx.fillStyle = anno.color;
    ctx.textBaseline = 'top';
    // Wrap basique sur largeur fixe (anno.width)
    const lines = wrapText(ctx, anno.content || '', anno.width);
    const lineHeight = anno.size * 1.3;
    lines.forEach((line, i) => {
      ctx.fillText(line, anno.x + 4, anno.y + 2 + i * lineHeight);
    });
    ctx.restore();
  }

  function wrapText (ctx, text, maxWidth) {
    const out = [];
    text.split('\n').forEach(paragraph => {
      const words = paragraph.split(' ');
      let line = '';
      for (const w of words) {
        const test = line ? `${line} ${w}` : w;
        if (ctx.measureText(test).width > maxWidth && line) {
          out.push(line);
          line = w;
        } else {
          line = test;
        }
      }
      out.push(line);
    });
    return out;
  }

  // ---------- Boot -------------------------------------------------------

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
