/* =============================================================================
   PDF Editor — logique principale
   ---------------------------------------------------------------------------
   - Outils : V (sélection), T (texte), P (stylo), E (gomme),
     R (rectangle), O (ellipse), L (ligne)
   - Annotations stockées par page dans `state.pages[i].annotations`, sous une
     forme commune {id,type,x,y,...} — voir editor/geometry.js pour le calque
     de transform générique (move/resize/rotate) partagé par tous les types.
   - Export : pages recopiées en vectoriel (pdf-lib) + annotations dessinées
     comme objets PDF natifs — voir editor/export.js.
============================================================================= */

import {
  clamp, rotateAround, frameCenter, boundsFromPoints, unionFrames,
  computeResizedFrame, computeRotation, RESIZE_HANDLES, rectsIntersect,
} from './editor/geometry.js';
import { computeSnap } from './editor/snapping.js';
import { shapeOutlinePoints, SHAPE_DEFAULTS } from './editor/shapes.js';
import { buildExportedPdfBytes } from './editor/export.js';

(() => {

  // ---------- Constantes ---------------------------------------------------

  const MIN_TEXT_WIDTH = 40;      // px, espace page (canvas)
  const MOVE_THRESHOLD = 2;       // px canvas — sous ce seuil, un drag = un clic
  const SNAP_TOLERANCE_PX = 6;    // px ÉCRAN (converti en unités canvas via le zoom)
  const DUPLICATE_OFFSET = 16;    // px canvas
  const PASTE_OFFSET = 16;        // px canvas
  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 8;
  const ZOOM_STEP = 1.2;
  const ARROW_STEP = 1;
  const ARROW_STEP_SHIFT = 10;

  // ---------- État global ------------------------------------------------

  const state = {
    mode: 'edit',        // 'edit' | 'merge' | 'compress'
    tool: 'select',
    pages: [],           // [{ width, height, scale, pdfPage?, annotations: [], el, overlay, svg, ctx, ... }]
    selection: { pageIndex: null, ids: new Set() },
    activePageIndex: null,
    mergeFiles: [],
    compressFile: null,
    compressResult: null,
    compressQuality: 'medium',
    history: [],         // pile undo — snapshots de state.pages[i].annotations
    future: [],           // pile redo
    clipboard: [],        // presse-papiers interne — indépendant de la page/du document
    pasteCount: 0,
    textStyle: { font: 'sans', size: 18, weight: 400, italic: false, color: '#120f0d' },
    penStyle: { color: '#120f0d', size: 3 },
    shapeStyle: { fill: SHAPE_DEFAULTS.rect.fill, stroke: '#120f0d', strokeWidth: 2, opacity: 1, radius: 0 },
    drawing: null,        // stroke en cours { pageIndex, strokeId }
    editingId: null,      // id de la text-anno en édition
    zoom: 1,
    spaceHeld: false,
  };

  let idSeq = 1;
  const uid = () => `a${idSeq++}`;

  // Bytes du PDF actuellement chargé (null si page vierge) — conservés pour
  // recopier les pages en vectoriel à l'export plutôt que repartir du rendu
  // canvas basse résolution.
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
    bindZoomBar();
    bindHelpPopover();
    updateUI();
  }

  // ---------- Bulle d'aide (raccourcis, footer) ---------------------------

  function bindHelpPopover () {
    const btn = $('btn-help');
    const panel = $('help-panel');
    if (!btn || !panel) return;

    const close = () => {
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
    };

    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (panel.hidden) open(); else close();
    });
    document.addEventListener('click', e => {
      if (!panel.hidden && e.target !== btn && !panel.contains(e.target) && !btn.contains(e.target)) close();
    });
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !panel.hidden) close();
    });
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
    $('zoom-bar').classList.toggle('is-hidden', mode !== 'edit' || state.pages.length === 0);
  }

  // ---------- Toolbar ------------------------------------------------------

  const SHAPE_TOOLS = ['rect', 'ellipse', 'line'];
  const PANEL_TOOLS = ['select', 'text', 'pen', 'erase'];

  function bindToolbar () {
    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });
  }

  function setTool (tool) {
    state.tool = tool;
    if (state.editingId) commitEditing();
    if (tool !== 'select') clearSelection();

    document.querySelectorAll('.tool-btn').forEach(b => {
      b.classList.toggle('is-active', b.dataset.tool === tool);
    });
    PANEL_TOOLS.forEach(t => {
      $(`panel-${t}`).classList.toggle('is-hidden', t !== tool);
    });
    $('panel-shape').classList.toggle('is-hidden', !SHAPE_TOOLS.includes(tool));
    state.pages.forEach(p => {
      p.overlay.className = `page__overlay page__overlay--${tool}`;
      p.el.dataset.tool = tool;
    });
    $('status-tool').textContent = `Outil : ${toolLabel(tool)}`;
  }

  function toolLabel (t) {
    return {
      select: 'Sélection', text: 'Texte', pen: 'Stylo', erase: 'Gomme',
      rect: 'Rectangle', ellipse: 'Ellipse', line: 'Ligne',
    }[t];
  }

  // ---------- Raccourcis clavier (couche centralisée) ---------------------

  function isMod (e) { return e.metaKey || e.ctrlKey; }

  function isTypingContext (e) {
    const t = e.target;
    return !!(t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'));
  }

  let arrowGestureOpen = false;

  function bindShortcuts () {
    window.addEventListener('keydown', (e) => {
      const typing = isTypingContext(e);

      // Undo / redo — actifs même en édition de texte (hors saisie native du champ).
      if (isMod(e) && e.key.toLowerCase() === 'z') {
        if (state.mode === 'edit' && !typing) {
          e.preventDefault();
          if (e.shiftKey) redo(); else undo();
        }
        return;
      }
      if (isMod(e) && e.key.toLowerCase() === 'y' && !typing) {
        if (state.mode === 'edit') { e.preventDefault(); redo(); }
        return;
      }

      if (state.mode !== 'edit') return;

      // Zoom — actif même en édition de texte tant qu'on ne tape pas dans un champ.
      if (isMod(e) && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomBy(ZOOM_STEP); return; }
      if (isMod(e) && e.key === '-') { e.preventDefault(); zoomBy(1 / ZOOM_STEP); return; }
      if (isMod(e) && e.key === '0') { e.preventDefault(); setZoom(1); return; }

      if (typing) {
        if (isMod(e) && e.key.toLowerCase() === 'a' && state.editingId) {
          e.preventDefault();
          selectAllTextInEditing();
        }
        return;
      }

      if (isMod(e) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); return; }
      if (isMod(e) && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelection(); return; }
      if (isMod(e) && e.key.toLowerCase() === 'x') { e.preventDefault(); cutSelection(); return; }
      if (isMod(e) && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); return; }
      if (isMod(e) && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAllOnActivePage(); return; }

      if (e.code === 'Space' && !state.spaceHeld) {
        state.spaceHeld = true;
        $('canvas-zone').classList.add('is-pan-ready');
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'v': setTool('select'); return;
        case 't': setTool('text'); return;
        case 'p': setTool('pen'); return;
        case 'e': setTool('erase'); return;
        case 'r': setTool('rect'); return;
        case 'o': setTool('ellipse'); return;
        case 'l': setTool('line'); return;
        case 'escape':
          if (state.editingId) commitEditing();
          else clearSelection();
          return;
        case 'delete':
        case 'backspace':
          if (state.selection.ids.size) { e.preventDefault(); deleteSelection(); }
          return;
      }

      if (state.selection.ids.size) {
        const step = e.shiftKey ? ARROW_STEP_SHIFT : ARROW_STEP;
        let dx = 0, dy = 0;
        if (e.key === 'ArrowLeft') dx = -step;
        else if (e.key === 'ArrowRight') dx = step;
        else if (e.key === 'ArrowUp') dy = -step;
        else if (e.key === 'ArrowDown') dy = step;
        if (dx || dy) {
          e.preventDefault();
          if (!e.repeat && !arrowGestureOpen) { pushHistory(); arrowGestureOpen = true; }
          nudgeSelection(dx, dy);
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        state.spaceHeld = false;
        $('canvas-zone').classList.remove('is-pan-ready');
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        arrowGestureOpen = false;
      }
    });
  }

  // ---------- Header (ouvrir / exporter / page blanche) -------------------

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

  // ---------- Panels -------------------------------------------------------

  // Coalescing d'historique pour les contrôles de panneau (slider/color qui
  // émettent des 'input' en continu) : une seule entrée d'undo par geste.
  let styleGestureOpen = false;
  function beginStyleGesture () {
    if (!styleGestureOpen) { pushHistory(); styleGestureOpen = true; }
  }
  function endStyleGesture () { styleGestureOpen = false; }

  function bindPanels () {
    // TEXT
    $('text-font').addEventListener('change', e => {
      beginStyleGesture();
      state.textStyle.font = e.target.value;
      applyToSelectedText({ font: e.target.value });
      endStyleGesture();
    });
    $('text-size').addEventListener('input', e => {
      beginStyleGesture();
      state.textStyle.size = +e.target.value;
      $('text-size-val').textContent = e.target.value;
      applyToSelectedText({ size: +e.target.value });
    });
    $('text-size').addEventListener('change', endStyleGesture);
    $('text-weight').addEventListener('change', e => {
      beginStyleGesture();
      state.textStyle.weight = +e.target.value;
      applyToSelectedText({ weight: +e.target.value });
      endStyleGesture();
    });
    $('text-italic').addEventListener('change', e => {
      beginStyleGesture();
      state.textStyle.italic = e.target.checked;
      applyToSelectedText({ italic: e.target.checked });
      endStyleGesture();
    });
    $('text-color').addEventListener('input', e => {
      beginStyleGesture();
      state.textStyle.color = e.target.value;
      applyToSelectedText({ color: e.target.value });
    });
    $('text-color').addEventListener('change', endStyleGesture);

    // PEN
    $('pen-size').addEventListener('input', e => {
      state.penStyle.size = +e.target.value;
      $('pen-size-val').textContent = e.target.value;
    });
    $('pen-color').addEventListener('input', e => {
      state.penStyle.color = e.target.value;
    });

    // SHAPE
    $('shape-fill').addEventListener('input', e => {
      beginStyleGesture();
      state.shapeStyle.fill = e.target.value;
      $('shape-fill-none').checked = false;
      applyToSelectedShapes({ fill: e.target.value });
    });
    $('shape-fill').addEventListener('change', endStyleGesture);
    $('shape-fill-none').addEventListener('change', e => {
      beginStyleGesture();
      state.shapeStyle.fill = e.target.checked ? 'none' : $('shape-fill').value;
      applyToSelectedShapes({ fill: state.shapeStyle.fill });
      endStyleGesture();
    });
    $('shape-stroke').addEventListener('input', e => {
      beginStyleGesture();
      state.shapeStyle.stroke = e.target.value;
      applyToSelectedShapes({ stroke: e.target.value });
    });
    $('shape-stroke').addEventListener('change', endStyleGesture);
    $('shape-stroke-width').addEventListener('input', e => {
      beginStyleGesture();
      state.shapeStyle.strokeWidth = +e.target.value;
      $('shape-stroke-width-val').textContent = e.target.value;
      applyToSelectedShapes({ strokeWidth: +e.target.value });
    });
    $('shape-stroke-width').addEventListener('change', endStyleGesture);
    $('shape-radius').addEventListener('input', e => {
      beginStyleGesture();
      state.shapeStyle.radius = +e.target.value;
      $('shape-radius-val').textContent = e.target.value;
      applyToSelectedShapes({ radius: +e.target.value });
    });
    $('shape-radius').addEventListener('change', endStyleGesture);
    $('shape-opacity').addEventListener('input', e => {
      beginStyleGesture();
      state.shapeStyle.opacity = +e.target.value / 100;
      $('shape-opacity-val').textContent = e.target.value;
      applyToSelectedShapes({ opacity: +e.target.value / 100 });
    });
    $('shape-opacity').addEventListener('change', endStyleGesture);

    // Swatches (texte + shapes)
    document.querySelectorAll('.swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        const target = sw.dataset.target;
        const color = sw.dataset.color;
        $(target).value = color;
        $(target).dispatchEvent(new Event('input', { bubbles: true }));
        $(target).dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
  }

  function activeSelectionPage () {
    if (state.selection.pageIndex === null) return null;
    return state.pages[state.selection.pageIndex] || null;
  }

  function selectedAnnos () {
    const page = activeSelectionPage();
    if (!page) return [];
    return Array.from(state.selection.ids)
      .map(id => page.annotations.find(a => a.id === id))
      .filter(Boolean);
  }

  function applyToSelectedText (patch) {
    const page = activeSelectionPage();
    if (!page) return;
    let changed = false;
    selectedAnnos().forEach(anno => {
      if (anno.type !== 'text') return;
      Object.assign(anno, patch);
      renderTextAnno(page, anno);
      changed = true;
    });
    if (changed) updateSelectionBox();
  }

  function applyToSelectedShapes (patch) {
    // Ne rafraîchit PAS le panneau de sélection : aucun champ de style (fill,
    // stroke, opacity, radius) n'affecte la frame, et ce patch est aussi
    // appelé en continu (slider 'input') par les contrôles générés
    // dynamiquement DANS ce panneau — le reconstruire à chaque tick
    // couperait le drag natif du slider.
    const page = activeSelectionPage();
    if (!page) return;
    selectedAnnos().forEach(anno => {
      if (anno.type !== 'shape') return;
      Object.assign(anno, patch);
      renderShape(page, anno);
    });
  }

  // ---------- Zoom & pan ---------------------------------------------------

  const PAGE_GAP = 24; // var(--b-space-24) — gap entre pages empilées dans #pages

  // Taille "naturelle" (zoom = 1) de la pile de pages, calculée à partir des
  // pages elles-mêmes plutôt que mesurée sur #pages : ce dernier est stretché
  // à la largeur de son parent (comportement par défaut d'un flex container
  // block-level) — parent qui est justement redimensionné selon le zoom, donc
  // le mesurer directement bouclerait sur lui-même (double application du zoom).
  function pagesNaturalSize () {
    if (state.pages.length === 0) return { width: 0, height: 0 };
    const width = Math.max(...state.pages.map(p => p.width));
    const height = state.pages.reduce((sum, p) => sum + p.height, 0) + PAGE_GAP * (state.pages.length - 1);
    return { width, height };
  }

  function applyZoomLayout () {
    const zoom = state.zoom;
    const pagesEl = $('pages');
    const viewport = $('pages-viewport');
    document.documentElement.style.setProperty('--zoom', zoom);
    $('zoom-reset').textContent = `${Math.round(zoom * 100)}%`;
    if (state.pages.length === 0) return;
    const natural = pagesNaturalSize();
    // Largeur explicite en unités NATURELLES (indépendante du zoom) : le
    // scale() ci-dessous s'applique une seule fois, pas de double comptage.
    pagesEl.style.width = `${natural.width}px`;
    pagesEl.style.transform = `scale(${zoom})`;
    viewport.style.width = `${natural.width * zoom}px`;
    viewport.style.height = `${natural.height * zoom}px`;
  }

  function setZoom (newZoom, anchor) {
    const zone = $('canvas-zone');
    const oldZoom = state.zoom;
    const clamped = clamp(newZoom, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(clamped - oldZoom) < 0.0001) return;

    const rect = zone.getBoundingClientRect();
    const clientX = anchor?.clientX ?? (rect.left + rect.width / 2);
    const clientY = anchor?.clientY ?? (rect.top + rect.height / 2);
    const contentX = (clientX - rect.left) + zone.scrollLeft;
    const contentY = (clientY - rect.top) + zone.scrollTop;
    const ratio = clamped / oldZoom;

    state.zoom = clamped;
    applyZoomLayout();

    zone.scrollLeft = contentX * ratio - (clientX - rect.left);
    zone.scrollTop = contentY * ratio - (clientY - rect.top);
    updateSelectionBox();
  }

  function zoomBy (factor) {
    setZoom(state.zoom * factor);
  }

  function fitPage () {
    if (state.pages.length === 0) return;
    const zone = $('canvas-zone');
    const page = state.pages[state.selection.pageIndex ?? state.activePageIndex ?? 0];
    const available = Math.min(
      (zone.clientWidth - 64) / page.width,
      (zone.clientHeight - 64) / page.height,
    );
    setZoom(clamp(available, MIN_ZOOM, MAX_ZOOM));
  }

  function bindZoomBar () {
    $('zoom-in').addEventListener('click', () => zoomBy(ZOOM_STEP));
    $('zoom-out').addEventListener('click', () => zoomBy(1 / ZOOM_STEP));
    $('zoom-reset').addEventListener('click', () => setZoom(1));
    $('zoom-fit').addEventListener('click', fitPage);
  }

  let panSession = null;

  function bindCanvasZone () {
    const zone = $('canvas-zone');

    zone.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return; // trackpad pinch (ou ctrl+molette) — le scroll normal reste natif
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.01);
      setZoom(state.zoom * factor, { clientX: e.clientX, clientY: e.clientY });
    }, { passive: false });

    zone.addEventListener('pointerdown', e => {
      if (e.target === zone || e.target === $('pages') || e.target === $('pages-viewport')) {
        if (state.editingId) commitEditing();
        clearSelection();
      }
      if (state.spaceHeld && e.button === 0) {
        panSession = { startX: e.clientX, startY: e.clientY, scrollLeft: zone.scrollLeft, scrollTop: zone.scrollTop };
        zone.classList.add('is-panning');
        const onMove = (ev) => {
          if (!panSession) return;
          zone.scrollLeft = panSession.scrollLeft - (ev.clientX - panSession.startX);
          zone.scrollTop = panSession.scrollTop - (ev.clientY - panSession.startY);
        };
        const onUp = () => {
          panSession = null;
          zone.classList.remove('is-panning');
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
      }
    });
  }

  // ---------- Chargement de PDF --------------------------------------------

  async function loadPDF (file) {
    const ab = await file.arrayBuffer();
    await loadPDFFromBytes(ab);
  }

  async function loadPDFFromBytes (bytes) {
    await ensurePdfJsReady();
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
    state.future = [];
    state.selection = { pageIndex: null, ids: new Set() };
    state.activePageIndex = null;
    state.editingId = null;
    state.zoom = 1;
  }

  function afterPagesLoaded () {
    $('empty-state').classList.add('is-hidden');
    $('status-pages').textContent = `${state.pages.length} page${state.pages.length > 1 ? 's' : ''}`;
    $('zoom-bar').classList.toggle('is-hidden', state.mode !== 'edit' || state.pages.length === 0);
    applyZoomLayout();
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

  // ---------- Rendu de page + calque de sélection générique ---------------

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

    registerPage({
      width: viewport.width, height: viewport.height,
      pdfWidth: baseViewport.width, pdfHeight: baseViewport.height,
      scale, pdfPage, el: pageEl, canvas, ctx,
    });
  }

  async function renderBlankPage () {
    const width = 794, height = 1123; // A4 @ ~96dpi
    const pageEl = createPageEl(width, height);
    const canvas = pageEl.querySelector('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    registerPage({
      width, height, pdfWidth: width, pdfHeight: height,
      scale: 1, pdfPage: null, el: pageEl, canvas, ctx,
    });
  }

  function registerPage (base) {
    const pageEl = base.el;
    const page = {
      ...base,
      annotations: [],
      overlay: pageEl.querySelector('.page__overlay'),
      svg: pageEl.querySelector('.page__svg'),
      selectionBox: pageEl.querySelector('.selection-box'),
      marqueeEl: pageEl.querySelector('.marquee-rect'),
      guideLayer: pageEl.querySelector('.guide-layer'),
    };
    state.pages.push(page);
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
      <div class="page__overlay page__overlay--select">
        <div class="marquee-rect"></div>
        <svg class="guide-layer" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;"></svg>
        <div class="selection-box">
          ${RESIZE_HANDLES.map(h => `<div class="selection-handle selection-handle--${h}" data-handle="${h}"></div>`).join('')}
          <div class="selection-rotate-stem"></div>
          <div class="selection-rotate-handle" data-handle="rotate"></div>
        </div>
      </div>
    `;
    $('pages').appendChild(el);
    return el;
  }

  // ---------- Page pointer events (dispatch par outil) --------------------

  function bindPageEvents (pageIndex) {
    const page = state.pages[pageIndex];
    // Attaché à .page (pas à l'overlay) : en sélection/gomme l'overlay ne
    // capte plus les clics (voir styles.css) pour laisser les shapes/tracés
    // du calque SVG recevoir directement les leurs ; les clics "fond de
    // page" remontent ici par bubbling puisque tout élément plus
    // spécifique (texte, shape, poignée) appelle stopPropagation().
    page.el.addEventListener('pointerdown', e => onPagePointerDown(e, pageIndex));
    bindSelectionHandles(pageIndex);
  }

  function pagePoint (e, page) {
    const rect = page.overlay.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (page.width / rect.width),
      y: (e.clientY - rect.top) * (page.height / rect.height),
    };
  }

  function onPagePointerDown (e, pageIndex) {
    if (e.button !== undefined && e.button !== 0) return;
    const page = state.pages[pageIndex];
    const { x, y } = pagePoint(e, page);
    state.activePageIndex = pageIndex;

    if (state.editingId) commitEditing();

    if (state.tool === 'text') {
      pushHistory();
      const anno = createTextAnno(x, y);
      page.annotations.push(anno);
      renderTextAnno(page, anno);
      selectOnly(pageIndex, anno.id);
      startEditing(pageIndex, anno.id);
      e.preventDefault();
      return;
    }

    if (state.tool === 'pen') {
      pushHistory();
      const stroke = { id: uid(), type: 'stroke', points: [{ x, y }], color: state.penStyle.color, size: state.penStyle.size };
      page.annotations.push(stroke);
      state.drawing = { pageIndex, strokeId: stroke.id };
      renderStroke(page, stroke);
      attachPenMoveHandlers();
      e.preventDefault();
      return;
    }

    if (SHAPE_TOOLS.includes(state.tool)) {
      startShapeCreateSession(pageIndex, state.tool, x, y, e);
      e.preventDefault();
      return;
    }

    if (state.tool === 'erase') {
      // Les éléments capturent déjà leurs propres clics (voir bindElementInteractions) ;
      // un clic dans le vide ici ne fait rien.
      return;
    }

    if (state.tool === 'select') {
      // On n'arrive ici que pour un clic "fond de page" : tout élément plus
      // spécifique (texte, shape, tracé, poignée) a déjà stoppé la
      // propagation dans son propre handler.
      startMarqueeSession(pageIndex, e);
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
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  // ---------- Création d'annotations ---------------------------------------

  function createTextAnno (x, y) {
    const s = state.textStyle;
    return {
      id: uid(), type: 'text', x, y, width: 200, content: '',
      font: s.font, size: s.size, weight: s.weight, italic: s.italic, color: s.color,
    };
  }

  function createShapeAnno (shapeType, x, y) {
    const s = state.shapeStyle;
    const anno = {
      id: uid(), type: 'shape', shape: shapeType,
      x, y, width: 0, height: 0, rotation: 0,
      fill: shapeType === 'line' ? 'none' : s.fill,
      stroke: s.stroke, strokeWidth: s.strokeWidth, opacity: s.opacity,
    };
    if (shapeType === 'rect') anno.radius = s.radius;
    return anno;
  }

  // ---------- Rendu : texte -------------------------------------------------

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
      page.overlay.insertBefore(el, page.marqueeEl);
      bindElementInteractions(state.pages.indexOf(page), anno.id, content, 'text');
      content.addEventListener('dblclick', e => {
        if (state.tool !== 'select') return;
        startEditing(+el.dataset.pageIndex, anno.id);
        e.stopPropagation();
      });
    } else {
      content = el.querySelector('.text-anno__content');
    }

    el.style.left = `${anno.x / page.width * 100}%`;
    el.style.top = `${anno.y / page.height * 100}%`;
    el.style.width = `${anno.width / page.width * 100}%`;
    content.style.fontFamily = anno.font === 'serif' ? 'var(--font-content-serif)' : 'var(--font-content-sans)';
    content.style.fontSize = `${anno.size}px`;
    content.style.fontWeight = anno.weight;
    content.style.fontStyle = anno.italic ? 'italic' : 'normal';
    content.style.color = anno.color;

    if (state.editingId !== anno.id) {
      content.textContent = anno.content;
    }
    el.classList.toggle('is-editing', state.editingId === anno.id);
  }

  function startEditing (pageIndex, annoId) {
    state.editingId = annoId;
    selectOnly(pageIndex, annoId);
    const page = state.pages[pageIndex];
    const el = page.overlay.querySelector(`[data-id="${annoId}"]`);
    if (!el) return;
    const content = el.querySelector('.text-anno__content');
    el.classList.add('is-editing');
    content.setAttribute('contenteditable', 'plaintext-only');
    content.focus();
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    updateSelectionBox();
  }

  function selectAllTextInEditing () {
    const page = state.pages[state.selection.pageIndex];
    if (!page) return;
    const el = page.overlay.querySelector(`[data-id="${state.editingId}"] .text-anno__content`);
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function commitEditing () {
    if (!state.editingId) return;
    const pageIndex = state.selection.pageIndex;
    const page = state.pages[pageIndex];
    const el = page?.overlay.querySelector(`[data-id="${state.editingId}"]`);
    if (!el) { state.editingId = null; return; }
    const content = el.querySelector('.text-anno__content');
    const anno = page.annotations.find(a => a.id === state.editingId);
    if (anno) anno.content = content.textContent;
    el.classList.remove('is-editing');
    content.removeAttribute('contenteditable');
    state.editingId = null;

    if (anno && !anno.content.trim()) {
      removeAnnoIds(pageIndex, [anno.id]);
    }
    updateSelectionBox();
  }

  // ---------- Rendu : tracés (stylo) — hit-area élargie pour les traits fins

  function renderStroke (page, stroke) {
    let g = page.svg.querySelector(`g[data-id="${stroke.id}"]`);
    let hit, visible;
    if (!g) {
      g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.dataset.id = stroke.id;
      hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hit.setAttribute('class', 'shape-el shape-el--line-hit');
      visible = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      g.appendChild(hit);
      g.appendChild(visible);
      page.svg.appendChild(g);
      bindElementInteractions(state.pages.indexOf(page), stroke.id, g, 'stroke');
    } else {
      [hit, visible] = g.children;
    }
    const d = smoothPath(stroke.points);
    hit.setAttribute('d', d);
    hit.setAttribute('stroke-width', Math.max(stroke.size, 14));
    visible.setAttribute('d', d);
    visible.setAttribute('stroke', stroke.color);
    visible.setAttribute('stroke-width', stroke.size);
    visible.setAttribute('fill', 'none');
    visible.setAttribute('stroke-linecap', 'round');
    visible.setAttribute('stroke-linejoin', 'round');
    g.classList.toggle('is-selected', isSelected(state.pages.indexOf(page), stroke.id));
    visible.style.filter = isSelected(state.pages.indexOf(page), stroke.id) ? 'drop-shadow(0 0 2px var(--b-accent))' : '';
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

  // ---------- Rendu : shapes (rectangle / ellipse / ligne) -----------------

  function renderShape (page, anno) {
    const pageIndex = state.pages.indexOf(page);
    let el = page.svg.querySelector(`[data-id="${anno.id}"]`);
    if (!el) {
      el = createShapeEl(anno);
      page.svg.appendChild(el);
      bindElementInteractions(pageIndex, anno.id, el, 'shape');
    }
    updateShapeEl(el, anno);
    const selected = isSelected(pageIndex, anno.id);
    const isLine = anno.shape === 'line' || anno.shape === 'arrow';
    (isLine ? el.children[1] : el).classList.toggle('is-selected', selected);
  }

  function createShapeEl (anno) {
    const svgns = 'http://www.w3.org/2000/svg';
    if (anno.shape === 'line' || anno.shape === 'arrow') {
      const g = document.createElementNS(svgns, 'g');
      g.dataset.id = anno.id;
      const hit = document.createElementNS(svgns, 'line');
      hit.setAttribute('class', 'shape-el shape-el--line-hit');
      const visible = document.createElementNS(svgns, 'line');
      visible.setAttribute('class', 'shape-el');
      g.appendChild(hit);
      g.appendChild(visible);
      return g;
    }
    const tag = anno.shape === 'ellipse' ? 'ellipse' : 'rect';
    const el = document.createElementNS(svgns, tag);
    el.dataset.id = anno.id;
    el.setAttribute('class', 'shape-el');
    return el;
  }

  function updateShapeEl (el, anno) {
    const center = frameCenter({ x: anno.x, y: anno.y, width: anno.width, height: anno.height });
    const rotation = anno.rotation || 0;
    const opacity = anno.opacity ?? 1;

    if (anno.shape === 'line' || anno.shape === 'arrow') {
      const [hit, visible] = el.children;
      [hit, visible].forEach(line => {
        line.setAttribute('x1', anno.x);
        line.setAttribute('y1', anno.y);
        line.setAttribute('x2', anno.x + anno.width);
        line.setAttribute('y2', anno.y + anno.height);
      });
      hit.setAttribute('stroke-width', Math.max(anno.strokeWidth || 1, 14));
      visible.setAttribute('stroke', anno.stroke && anno.stroke !== 'none' ? anno.stroke : 'transparent');
      visible.setAttribute('stroke-width', Math.max(0, anno.strokeWidth || 0));
      visible.setAttribute('stroke-linecap', 'round');
      visible.style.opacity = opacity;
      return;
    }

    if (anno.shape === 'ellipse') {
      el.setAttribute('cx', anno.x + anno.width / 2);
      el.setAttribute('cy', anno.y + anno.height / 2);
      el.setAttribute('rx', Math.max(0, anno.width / 2));
      el.setAttribute('ry', Math.max(0, anno.height / 2));
    } else {
      el.setAttribute('x', anno.x);
      el.setAttribute('y', anno.y);
      el.setAttribute('width', Math.max(0, anno.width));
      el.setAttribute('height', Math.max(0, anno.height));
      el.setAttribute('rx', Math.max(0, anno.radius || 0));
    }
    el.setAttribute('fill', anno.fill && anno.fill !== 'none' ? anno.fill : 'transparent');
    el.setAttribute('stroke', anno.stroke && anno.stroke !== 'none' ? anno.stroke : 'none');
    el.setAttribute('stroke-width', Math.max(0, anno.strokeWidth || 0));
    el.style.opacity = opacity;
    el.setAttribute('transform', rotation ? `rotate(${rotation} ${center.x} ${center.y})` : '');
  }

  // ---------- Interaction générique par élément -----------------------------

  function bindElementInteractions (pageIndex, annoId, el, type) {
    el.addEventListener('pointerdown', e => onElementPointerDown(e, pageIndex, annoId, type));
  }

  function onElementPointerDown (e, pageIndex, annoId, type) {
    const page = state.pages[pageIndex];

    if (state.tool === 'erase') {
      pushHistory();
      removeAnnoIds(pageIndex, [annoId]);
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    if (state.tool === 'text') {
      if (type === 'text') {
        selectOnly(pageIndex, annoId);
        startEditing(pageIndex, annoId);
        e.stopPropagation();
        e.preventDefault();
      }
      return;
    }

    // Cliquer une shape existante pendant que l'outil forme correspondant
    // est actif la (re)sélectionne — sans ça, il serait impossible de
    // revenir éditer son style via le panneau (passer sur l'outil la
    // désélectionne, cf. setTool) : même principe que pour le texte ci-dessus.
    if (SHAPE_TOOLS.includes(state.tool)) {
      if (type === 'shape') {
        selectOnly(pageIndex, annoId);
        e.stopPropagation();
        e.preventDefault();
      }
      return;
    }

    if (state.tool !== 'select') return;

    if (state.editingId === annoId) { e.stopPropagation(); return; }
    if (state.editingId) commitEditing();

    state.activePageIndex = pageIndex;
    const wasMulti = state.selection.ids.size > 1;
    const alreadySelected = isSelected(pageIndex, annoId);

    if (e.shiftKey) {
      toggleSelectionMember(pageIndex, annoId);
    } else if (!alreadySelected) {
      selectOnly(pageIndex, annoId);
    }

    if (state.selection.ids.size === 0) { e.stopPropagation(); e.preventDefault(); return; }

    startTransformSession('move', pageIndex, e, {
      duplicateOnStart: e.altKey && alreadySelected,
      collapseOnClick: !e.shiftKey && wasMulti && alreadySelected,
      clickedId: annoId,
    });
    e.stopPropagation();
    e.preventDefault();
  }

  // ---------- Sélection ------------------------------------------------------

  function isSelected (pageIndex, id) {
    return state.selection.pageIndex === pageIndex && state.selection.ids.has(id);
  }

  function selectOnly (pageIndex, id) {
    setSelectionIds(pageIndex, [id]);
  }

  function toggleSelectionMember (pageIndex, id) {
    if (state.selection.pageIndex !== pageIndex) {
      setSelectionIds(pageIndex, [id]);
      return;
    }
    const ids = new Set(state.selection.ids);
    if (ids.has(id)) ids.delete(id); else ids.add(id);
    setSelectionIds(pageIndex, Array.from(ids));
  }

  function setSelectionIds (pageIndex, ids) {
    const prevPage = state.selection.pageIndex;
    state.selection = { pageIndex, ids: new Set(ids) };
    if (prevPage !== null && prevPage !== pageIndex) refreshAllAnnos(state.pages[prevPage]);
    refreshAllAnnos(state.pages[pageIndex]);
    updateSelectionBox();
    updateSelectedPanel();
  }

  function clearSelection () {
    if (state.selection.ids.size === 0) return;
    const page = activeSelectionPage();
    state.selection = { pageIndex: null, ids: new Set() };
    if (page) refreshAllAnnos(page);
    updateSelectionBox();
    updateSelectedPanel();
  }

  function refreshAllAnnos (page) {
    if (!page) return;
    page.annotations.forEach(a => refreshAnno(page, a));
  }

  function refreshAnno (page, anno) {
    if (anno.type === 'text') renderTextAnno(page, anno);
    else if (anno.type === 'stroke') renderStroke(page, anno);
    else if (anno.type === 'shape') renderShape(page, anno);
  }

  function selectAllOnActivePage () {
    const pageIndex = state.selection.pageIndex ?? state.activePageIndex ?? (state.pages.length ? 0 : null);
    if (pageIndex === null) return;
    const page = state.pages[pageIndex];
    setSelectionIds(pageIndex, page.annotations.map(a => a.id));
  }

  function deleteSelection () {
    if (!state.selection.ids.size) return;
    pushHistory();
    removeAnnoIds(state.selection.pageIndex, Array.from(state.selection.ids));
  }

  function removeAnnoIds (pageIndex, ids) {
    const page = state.pages[pageIndex];
    if (!page) return;
    const idSet = new Set(ids);
    page.annotations = page.annotations.filter(a => {
      if (!idSet.has(a.id)) return true;
      if (a.type === 'text') page.overlay.querySelector(`[data-id="${a.id}"]`)?.remove();
      else page.svg.querySelector(`[data-id="${a.id}"]`)?.remove();
      return false;
    });
    if (state.selection.pageIndex === pageIndex) {
      const remaining = Array.from(state.selection.ids).filter(id => !idSet.has(id));
      state.selection = { pageIndex: remaining.length ? pageIndex : null, ids: new Set(remaining) };
    }
    updateSelectionBox();
    updateSelectedPanel();
  }

  // ---------- Frame générique (bbox) par type d'élément ---------------------

  function getFrame (anno, page) {
    if (anno.type === 'text') {
      const el = page.overlay.querySelector(`[data-id="${anno.id}"] .text-anno__content`);
      const height = el ? el.offsetHeight : Math.round(anno.size * 1.3) + 4;
      return { x: anno.x, y: anno.y, width: anno.width, height, rotation: 0 };
    }
    if (anno.type === 'stroke') {
      const b = boundsFromPoints(anno.points);
      return { x: b.x, y: b.y, width: b.width, height: b.height, rotation: 0 };
    }
    return { x: anno.x, y: anno.y, width: anno.width, height: anno.height, rotation: anno.rotation || 0 };
  }

  function minSizeFor (anno) {
    if (anno.type === 'text') return { minWidth: MIN_TEXT_WIDTH, minHeight: 1 };
    return { minWidth: 2, minHeight: 2 };
  }

  // Applique une frame résultat de resize à l'annotation (mutation + rendu).
  // snapshot: { frame, size?, points? } capturé au DÉBUT du geste.
  function applyFrameToAnno (anno, newFrame, snapshot, page, opts = {}) {
    if (anno.type === 'text') {
      anno.x = newFrame.x;
      anno.width = Math.max(MIN_TEXT_WIDTH, newFrame.width);
      if (opts.scaleFontSize && snapshot.frame.width > 0) {
        const scale = newFrame.width / snapshot.frame.width;
        anno.size = clamp(Math.round(snapshot.size * scale), 4, 400);
      }
      renderTextAnno(page, anno);
      return;
    }
    if (anno.type === 'stroke') {
      const old = snapshot.frame;
      const sx = old.width ? newFrame.width / old.width : 1;
      const sy = old.height ? newFrame.height / old.height : 1;
      anno.points = snapshot.points.map(p => ({
        x: newFrame.x + (p.x - old.x) * sx,
        y: newFrame.y + (p.y - old.y) * sy,
      }));
      renderStroke(page, anno);
      return;
    }
    anno.x = newFrame.x; anno.y = newFrame.y;
    anno.width = newFrame.width; anno.height = newFrame.height;
    anno.rotation = newFrame.rotation;
    renderShape(page, anno);
  }

  function translateAnno (anno, dx, dy, page, snapshot) {
    if (anno.type === 'text') {
      anno.x = snapshot.frame.x + dx;
      anno.y = snapshot.frame.y + dy;
      renderTextAnno(page, anno);
    } else if (anno.type === 'stroke') {
      anno.points = snapshot.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
      renderStroke(page, anno);
    } else {
      anno.x = snapshot.frame.x + dx;
      anno.y = snapshot.frame.y + dy;
      renderShape(page, anno);
    }
  }

  // ---------- Sélection : bounding box + poignées (rendu) -------------------

  function updateSelectionBox () {
    state.pages.forEach((page, i) => {
      if (i !== state.selection.pageIndex || state.selection.ids.size === 0) {
        page.selectionBox.classList.remove('is-active');
      }
    });
    if (state.selection.ids.size === 0) return;
    const page = state.pages[state.selection.pageIndex];
    if (!page) return;

    const annos = selectedAnnos();
    const frames = annos.map(a => getFrame(a, page));
    const group = unionFrames(frames);
    if (!group) return;

    const box = page.selectionBox;
    const single = annos.length === 1 ? annos[0] : null;
    const rotation = single ? (getFrame(single, page).rotation || 0) : 0;

    box.classList.add('is-active');
    box.classList.toggle('is-multi', annos.length > 1);
    box.classList.toggle('hide-ns', single?.type === 'text');
    box.classList.toggle('no-rotate', !single || single.type === 'text');

    box.style.left = `${group.x / page.width * 100}%`;
    box.style.top = `${group.y / page.height * 100}%`;
    box.style.width = `${group.width / page.width * 100}%`;
    box.style.height = `${group.height / page.height * 100}%`;
    box.style.transform = rotation ? `rotate(${rotation}deg)` : '';
    box.style.transformOrigin = '50% 50%';

    updateSelectedPanel();
  }

  function bindSelectionHandles (pageIndex) {
    const page = state.pages[pageIndex];
    page.selectionBox.querySelectorAll('[data-handle]').forEach(handle => {
      handle.addEventListener('pointerdown', e => {
        if (state.tool !== 'select' || state.selection.pageIndex !== pageIndex) return;
        e.stopPropagation();
        e.preventDefault();
        const kind = handle.dataset.handle === 'rotate' ? 'rotate' : 'resize';
        startTransformSession(kind, pageIndex, e, { handle: handle.dataset.handle });
      });
    });
  }

  // ---------- Session de transform générique (move / resize / rotate / marquee / shape-create)

  let session = null;

  function otherFramesOnPage (page, excludeIds) {
    return page.annotations
      .filter(a => !excludeIds.has(a.id))
      .map(a => getFrame(a, page));
  }

  function showSnapGuides (page, guides) {
    page.guideLayer.innerHTML = guides.map(g => {
      return g.axis === 'x'
        ? `<line x1="${g.value}" y1="0" x2="${g.value}" y2="${page.height}" stroke="#f04000" stroke-width="${1 / state.zoom}" />`
        : `<line x1="0" y1="${g.value}" x2="${page.width}" y2="${g.value}" stroke="#f04000" stroke-width="${1 / state.zoom}" />`;
    }).join('');
  }

  function clearSnapGuides (page) {
    page.guideLayer.innerHTML = '';
  }

  function startTransformSession (kind, pageIndex, e, opts = {}) {
    const page = state.pages[pageIndex];
    const pointerStart = pagePoint(e, page);

    if (kind === 'move') {
      let ids = Array.from(state.selection.ids);
      let historyPushed = false;

      if (opts.duplicateOnStart) {
        pushHistory();
        const newIds = duplicateElements(pageIndex, ids, 0, 0);
        state.selection = { pageIndex, ids: new Set(newIds) };
        ids = newIds;
        historyPushed = true;
        updateSelectionBox();
        refreshAllAnnos(page);
      }

      const snapshots = ids.map(id => snapshotOf(page, id));
      session = {
        kind: 'move', pageIndex, pointerStart, snapshots,
        historyPushed, collapseOnClick: !!opts.collapseOnClick, clickedId: opts.clickedId,
      };
    } else if (kind === 'resize') {
      const ids = Array.from(state.selection.ids);
      const snapshots = ids.map(id => snapshotOf(page, id));
      const groupFrame = unionFrames(snapshots.map(s => s.frame));
      session = {
        kind: 'resize', pageIndex, pointerStart, snapshots, handle: opts.handle,
        groupFrame, single: ids.length === 1,
        historyPushed: false,
      };
    } else if (kind === 'rotate') {
      const id = Array.from(state.selection.ids)[0];
      const snap = snapshotOf(page, id);
      const center = frameCenter(snap.frame);
      session = {
        kind: 'rotate', pageIndex, pointerStart, snapshot: snap, id, center,
        startRotation: snap.frame.rotation || 0, historyPushed: false,
      };
    } else if (kind === 'marquee') {
      session = { kind: 'marquee', pageIndex, pointerStart, additive: e.shiftKey };
      page.marqueeEl.classList.add('is-active');
    } else if (kind === 'shape-create') {
      session = { kind: 'shape-create', pageIndex, pointerStart, anno: opts.anno };
    }

    window.addEventListener('pointermove', onSessionPointerMove);
    window.addEventListener('pointerup', onSessionPointerUp, { once: true });
    window.addEventListener('pointercancel', onSessionPointerUp, { once: true });
  }

  function snapshotOf (page, id) {
    const anno = page.annotations.find(a => a.id === id);
    const frame = getFrame(anno, page);
    const extra = {};
    if (anno.type === 'text') extra.size = anno.size;
    if (anno.type === 'stroke') extra.points = anno.points.map(p => ({ ...p }));
    return { id, type: anno.type, frame, ...extra };
  }

  function startMarqueeSession (pageIndex, e) {
    startTransformSession('marquee', pageIndex, e);
  }

  function startShapeCreateSession (pageIndex, shapeType, x, y, e) {
    pushHistory();
    const page = state.pages[pageIndex];
    const anno = createShapeAnno(shapeType, x, y);
    page.annotations.push(anno);
    renderShape(page, anno);
    startTransformSession('shape-create', pageIndex, e, { anno });
  }

  function onSessionPointerMove (e) {
    if (!session) return;
    const page = state.pages[session.pageIndex];
    const cur = pagePoint(e, page);
    const dx = cur.x - session.pointerStart.x;
    const dy = cur.y - session.pointerStart.y;

    if (session.kind === 'move') {
      if (!session.historyPushed) {
        if (Math.hypot(dx, dy) < MOVE_THRESHOLD) return;
        pushHistory();
        session.historyPushed = true;
      }
      session.moved = true;
      let ddx = dx, ddy = dy;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) ddy = 0; else ddx = 0; }

      const groupFrame = unionFrames(session.snapshots.map(s => s.frame));
      const movingFrame = { x: groupFrame.x + ddx, y: groupFrame.y + ddy, width: groupFrame.width, height: groupFrame.height };
      const excludeIds = new Set(session.snapshots.map(s => s.id));
      const others = otherFramesOnPage(page, excludeIds);
      const tol = SNAP_TOLERANCE_PX / state.zoom;
      const snap = computeSnap(movingFrame, others, { width: page.width, height: page.height }, [], tol);
      ddx += snap.dx; ddy += snap.dy;
      showSnapGuides(page, snap.guides);

      session.snapshots.forEach(s => {
        const anno = page.annotations.find(a => a.id === s.id);
        translateAnno(anno, ddx, ddy, page, s);
      });
      updateSelectionBox();
    }

    else if (session.kind === 'resize') {
      if (!session.historyPushed) { pushHistory(); session.historyPushed = true; }
      const opts = { keepRatio: e.shiftKey, fromCenter: e.altKey, ...minSizeFor({ type: session.snapshots[0].type }) };

      if (session.single) {
        const s = session.snapshots[0];
        const anno = page.annotations.find(a => a.id === s.id);
        const newFrame = computeResizedFrame(s.frame, session.handle, dx, dy, opts);
        const corner = ['nw', 'ne', 'sw', 'se'].includes(session.handle);
        applyFrameToAnno(anno, newFrame, s, page, { scaleFontSize: corner });
      } else {
        const newGroupFrame = computeResizedFrame(session.groupFrame, session.handle, dx, dy, { ...opts, minWidth: 2, minHeight: 2 });
        const scaleX = session.groupFrame.width ? newGroupFrame.width / session.groupFrame.width : 1;
        const scaleY = session.groupFrame.height ? newGroupFrame.height / session.groupFrame.height : 1;
        session.snapshots.forEach(s => {
          const anno = page.annotations.find(a => a.id === s.id);
          const itemNewFrame = {
            x: newGroupFrame.x + (s.frame.x - session.groupFrame.x) * scaleX,
            y: newGroupFrame.y + (s.frame.y - session.groupFrame.y) * scaleY,
            width: s.frame.width * scaleX,
            height: s.frame.height * scaleY,
            rotation: s.frame.rotation,
          };
          applyFrameToAnno(anno, itemNewFrame, s, page, {});
        });
      }
      updateSelectionBox();
    }

    else if (session.kind === 'rotate') {
      if (!session.historyPushed) { pushHistory(); session.historyPushed = true; }
      const snapDeg = e.shiftKey ? 15 : 0;
      const newRotation = computeRotation(session.center, session.pointerStart, cur, session.startRotation, snapDeg);
      const anno = page.annotations.find(a => a.id === session.id);
      if (anno.type === 'shape') {
        anno.rotation = newRotation;
        renderShape(page, anno);
      } else if (anno.type === 'stroke') {
        const deltaDeg = newRotation - session.startRotation;
        anno.points = session.snapshot.points.map(p => rotateAround(p.x, p.y, session.center.x, session.center.y, deltaDeg));
        renderStroke(page, anno);
      }
      showRotateReadout(page, newRotation);
      updateSelectionBox();
    }

    else if (session.kind === 'marquee') {
      const x = Math.min(session.pointerStart.x, cur.x);
      const y = Math.min(session.pointerStart.y, cur.y);
      const width = Math.abs(cur.x - session.pointerStart.x);
      const height = Math.abs(cur.y - session.pointerStart.y);
      session.rect = { x, y, width, height };
      page.marqueeEl.style.left = `${x / page.width * 100}%`;
      page.marqueeEl.style.top = `${y / page.height * 100}%`;
      page.marqueeEl.style.width = `${width / page.width * 100}%`;
      page.marqueeEl.style.height = `${height / page.height * 100}%`;
    }

    else if (session.kind === 'shape-create') {
      const anno = session.anno;
      let x0 = session.pointerStart.x, y0 = session.pointerStart.y;
      let x1 = cur.x, y1 = cur.y;
      if (e.shiftKey) {
        const size = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
        x1 = x0 + Math.sign(x1 - x0 || 1) * size;
        y1 = y0 + Math.sign(y1 - y0 || 1) * size;
      }
      if (e.altKey) {
        const halfW = Math.abs(x1 - x0), halfH = Math.abs(y1 - y0);
        anno.x = x0 - halfW; anno.y = y0 - halfH;
        anno.width = halfW * 2; anno.height = halfH * 2;
      } else if (anno.shape === 'line' || anno.shape === 'arrow') {
        anno.x = x0; anno.y = y0; anno.width = x1 - x0; anno.height = y1 - y0;
      } else {
        anno.x = Math.min(x0, x1); anno.y = Math.min(y0, y1);
        anno.width = Math.abs(x1 - x0); anno.height = Math.abs(y1 - y0);
      }
      renderShape(page, anno);
    }
  }

  function showRotateReadout (page, deg) {
    let el = page.overlay.querySelector('.rotate-readout');
    if (!el) {
      el = document.createElement('div');
      el.className = 'rotate-readout';
      page.selectionBox.appendChild(el);
    }
    el.textContent = `${Math.round(deg)}°`;
  }

  function clearRotateReadout (page) {
    page.overlay.querySelector('.rotate-readout')?.remove();
  }

  function onSessionPointerUp () {
    if (!session) return;
    const page = state.pages[session.pageIndex];
    window.removeEventListener('pointermove', onSessionPointerMove);

    if (session.kind === 'move') {
      clearSnapGuides(page);
      if (!session.moved && session.collapseOnClick) {
        selectOnly(session.pageIndex, session.clickedId);
      }
    } else if (session.kind === 'resize') {
      // rien de plus
    } else if (session.kind === 'rotate') {
      clearRotateReadout(page);
    } else if (session.kind === 'marquee') {
      page.marqueeEl.classList.remove('is-active');
      if (session.rect && session.rect.width > 1 && session.rect.height > 1) {
        const hitIds = page.annotations
          .filter(a => rectsIntersect(session.rect, getFrame(a, page)))
          .map(a => a.id);
        if (session.additive && state.selection.pageIndex === session.pageIndex) {
          const merged = new Set(state.selection.ids);
          hitIds.forEach(id => merged.add(id));
          setSelectionIds(session.pageIndex, Array.from(merged));
        } else {
          setSelectionIds(session.pageIndex, hitIds);
        }
      } else if (!session.additive) {
        clearSelection();
      }
    } else if (session.kind === 'shape-create') {
      const anno = session.anno;
      const tooSmall = Math.abs(anno.width) < 4 && Math.abs(anno.height) < 4;
      if (tooSmall) {
        if (anno.shape === 'line' || anno.shape === 'arrow') {
          anno.x -= 60; anno.width = 120; anno.height = 0;
        } else {
          anno.x -= 50; anno.y -= 50; anno.width = 100; anno.height = 100;
        }
        renderShape(page, anno);
      }
      selectOnly(session.pageIndex, anno.id);
      setTool('select');
    }

    session = null;
  }

  // ---------- Duplication / clipboard / align / distribute / nudge --------

  function deepClone (x) { return JSON.parse(JSON.stringify(x)); }

  function duplicateElements (pageIndex, ids, dx, dy) {
    const page = state.pages[pageIndex];
    const newIds = [];
    ids.forEach(id => {
      const src = page.annotations.find(a => a.id === id);
      if (!src) return;
      const clone = deepClone(src);
      clone.id = uid();
      if (clone.type === 'stroke') {
        clone.points = clone.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
      } else {
        clone.x += dx; clone.y += dy;
      }
      page.annotations.push(clone);
      refreshAnno(page, clone);
      newIds.push(clone.id);
    });
    return newIds;
  }

  function duplicateSelection () {
    if (!state.selection.ids.size) return;
    pushHistory();
    const pageIndex = state.selection.pageIndex;
    const newIds = duplicateElements(pageIndex, Array.from(state.selection.ids), DUPLICATE_OFFSET, DUPLICATE_OFFSET);
    setSelectionIds(pageIndex, newIds);
  }

  function copySelection () {
    if (!state.selection.ids.size) return;
    state.clipboard = selectedAnnos().map(a => deepClone(a));
    state.pasteCount = 0;
  }

  function cutSelection () {
    if (!state.selection.ids.size) return;
    copySelection();
    deleteSelection();
  }

  function pasteClipboard () {
    if (!state.clipboard.length) return;
    const pageIndex = state.selection.pageIndex ?? state.activePageIndex ?? (state.pages.length ? 0 : null);
    if (pageIndex === null) return;
    pushHistory();
    state.pasteCount += 1;
    const offset = PASTE_OFFSET * state.pasteCount;
    const page = state.pages[pageIndex];
    const newIds = [];
    state.clipboard.forEach(src => {
      const clone = deepClone(src);
      clone.id = uid();
      if (clone.type === 'stroke') {
        clone.points = clone.points.map(p => ({ x: p.x + offset, y: p.y + offset }));
      } else {
        clone.x += offset; clone.y += offset;
      }
      page.annotations.push(clone);
      refreshAnno(page, clone);
      newIds.push(clone.id);
    });
    setSelectionIds(pageIndex, newIds);
  }

  function nudgeSelection (dx, dy) {
    const page = activeSelectionPage();
    if (!page) return;
    selectedAnnos().forEach(anno => {
      if (anno.type === 'stroke') {
        anno.points = anno.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
        renderStroke(page, anno);
      } else {
        anno.x += dx; anno.y += dy;
        refreshAnno(page, anno);
      }
    });
    updateSelectionBox();
  }

  function alignSelection (direction) {
    const page = activeSelectionPage();
    const annos = selectedAnnos();
    if (!page || annos.length < 2) return;
    pushHistory();
    const items = annos.map(a => ({ anno: a, frame: getFrame(a, page) }));
    const group = unionFrames(items.map(i => i.frame));
    items.forEach(({ anno, frame }) => {
      let dx = 0, dy = 0;
      switch (direction) {
        case 'left': dx = group.x - frame.x; break;
        case 'hcenter': dx = (group.x + group.width / 2) - (frame.x + frame.width / 2); break;
        case 'right': dx = (group.x + group.width) - (frame.x + frame.width); break;
        case 'top': dy = group.y - frame.y; break;
        case 'vcenter': dy = (group.y + group.height / 2) - (frame.y + frame.height / 2); break;
        case 'bottom': dy = (group.y + group.height) - (frame.y + frame.height); break;
      }
      if (anno.type === 'stroke') anno.points = anno.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
      else { anno.x += dx; anno.y += dy; }
      refreshAnno(page, anno);
    });
    updateSelectionBox();
  }

  function distributeSelection (axis) {
    const page = activeSelectionPage();
    const annos = selectedAnnos();
    if (!page || annos.length < 3) return;
    pushHistory();
    const items = annos.map(a => ({ anno: a, frame: getFrame(a, page) }));
    const key = axis === 'h' ? 'x' : 'y';
    const sizeKey = axis === 'h' ? 'width' : 'height';
    items.sort((a, b) => a.frame[key] - b.frame[key]);

    const first = items[0], last = items[items.length - 1];
    const span = (last.frame[key] + last.frame[sizeKey]) - first.frame[key];
    const totalSize = items.reduce((sum, i) => sum + i.frame[sizeKey], 0);
    const gap = (span - totalSize) / (items.length - 1);

    let cursor = first.frame[key] + first.frame[sizeKey] + gap;
    for (let i = 1; i < items.length - 1; i++) {
      const { anno, frame } = items[i];
      const delta = cursor - frame[key];
      if (axis === 'h') {
        if (anno.type === 'stroke') anno.points = anno.points.map(p => ({ x: p.x + delta, y: p.y }));
        else anno.x += delta;
      } else {
        if (anno.type === 'stroke') anno.points = anno.points.map(p => ({ x: p.x, y: p.y + delta }));
        else anno.y += delta;
      }
      refreshAnno(page, anno);
      cursor += frame[sizeKey] + gap;
    }
    updateSelectionBox();
  }

  // ---------- Panneau contextuel de sélection -------------------------------

  function updateSelectedPanel () {
    const target = $('panel-selected');
    const page = activeSelectionPage();
    const annos = selectedAnnos();

    if (!page || annos.length === 0) {
      target.innerHTML = `<p class="panel__hint">Clique sur un élément pour le sélectionner. Glisse pour déplacer. Glisse dans le vide pour une sélection multiple. <kbd>Suppr</kbd> pour effacer.</p>`;
      return;
    }

    const frames = annos.map(a => getFrame(a, page));
    const group = unionFrames(frames);
    const single = annos.length === 1 ? annos[0] : null;
    const singleFrame = single ? frames[0] : null;

    let hint = '';
    if (single?.type === 'text') {
      hint = `<p class="panel__hint">Zone de texte sélectionnée. Passe en outil <kbd>T</kbd> pour éditer ses réglages, ou double-clique pour éditer le contenu.</p>`;
    } else if (single?.type === 'stroke') {
      hint = `<p class="panel__hint">Tracé sélectionné — glisse pour déplacer, poignée ronde pour pivoter, <kbd>⌫</kbd> pour supprimer.</p>`;
    } else if (single?.type === 'shape') {
      hint = `<p class="panel__hint">Forme sélectionnée.</p>`;
    } else if (annos.length > 1) {
      hint = `<p class="panel__hint">${annos.length} éléments sélectionnés.</p>`;
    }

    const showH = !single || single.type !== 'text';
    const showRotation = single && single.type === 'shape';

    const fieldsHtml = `
      <div class="field-grid">
        <div class="field"><label class="field-label">X</label><input type="number" id="sel-x" value="${Math.round(group.x)}"></div>
        <div class="field"><label class="field-label">Y</label><input type="number" id="sel-y" value="${Math.round(group.y)}"></div>
        <div class="field"><label class="field-label">L</label><input type="number" id="sel-w" value="${Math.round(group.width)}"></div>
        ${showH ? `<div class="field"><label class="field-label">H</label><input type="number" id="sel-h" value="${Math.round(group.height)}"></div>` : ''}
        ${showRotation ? `<div class="field"><label class="field-label">°</label><input type="number" id="sel-rotation" value="${Math.round(singleFrame.rotation)}"></div>` : ''}
      </div>`;

    const shapeStyleHtml = single?.type === 'shape' ? `
      <div class="field">
        <label class="field-label">Remplissage</label>
        <div class="palette">
          <input type="color" id="sel-shape-fill" value="${single.fill && single.fill !== 'none' ? single.fill : '#f06800'}">
          <label class="check">
            <span class="switch"><input type="checkbox" id="sel-shape-fill-none" ${!single.fill || single.fill === 'none' ? 'checked' : ''}><span class="slider"></span></span>
            Aucun
          </label>
        </div>
      </div>
      <div class="field">
        <label class="field-label">Contour</label>
        <input type="color" id="sel-shape-stroke" value="${single.stroke && single.stroke !== 'none' ? single.stroke : '#120f0d'}">
      </div>
      <div class="field">
        <label class="slider-label">Épaisseur<span class="field-value" id="sel-shape-stroke-width-val">${single.strokeWidth}</span></label>
        <input type="range" id="sel-shape-stroke-width" min="0" max="24" value="${single.strokeWidth}">
      </div>
      ${single.shape === 'rect' ? `<div class="field">
        <label class="slider-label">Rayon des coins<span class="field-value" id="sel-shape-radius-val">${single.radius || 0}</span></label>
        <input type="range" id="sel-shape-radius" min="0" max="80" value="${single.radius || 0}">
      </div>` : ''}
      <div class="field">
        <label class="slider-label">Opacité<span class="field-value" id="sel-shape-opacity-val">${Math.round((single.opacity ?? 1) * 100)}</span></label>
        <input type="range" id="sel-shape-opacity" min="0" max="100" value="${Math.round((single.opacity ?? 1) * 100)}">
      </div>
    ` : '';

    const alignHtml = annos.length >= 2 ? `
      <div class="align-row">
        <button class="merge-item__btn" data-align="left" title="Aligner à gauche">⟸</button>
        <button class="merge-item__btn" data-align="hcenter" title="Centrer horizontalement">↔</button>
        <button class="merge-item__btn" data-align="right" title="Aligner à droite">⟹</button>
        <button class="merge-item__btn" data-align="top" title="Aligner en haut">⟰</button>
        <button class="merge-item__btn" data-align="vcenter" title="Centrer verticalement">↕</button>
        <button class="merge-item__btn" data-align="bottom" title="Aligner en bas">⟱</button>
      </div>
      ${annos.length >= 3 ? `
      <div class="align-row">
        <button class="merge-item__btn merge-item__btn--wide" data-distribute="h" title="Distribuer horizontalement">⇔ Distribuer H</button>
        <button class="merge-item__btn merge-item__btn--wide" data-distribute="v" title="Distribuer verticalement">⇕ Distribuer V</button>
      </div>` : ''}
    ` : '';

    target.innerHTML = hint + fieldsHtml + shapeStyleHtml + alignHtml;

    if (single?.type === 'shape') {
      $('sel-shape-fill').addEventListener('input', e => {
        beginStyleGesture();
        $('sel-shape-fill-none').checked = false;
        applyToSelectedShapes({ fill: e.target.value });
      });
      $('sel-shape-fill').addEventListener('change', endStyleGesture);
      $('sel-shape-fill-none').addEventListener('change', e => {
        beginStyleGesture();
        applyToSelectedShapes({ fill: e.target.checked ? 'none' : $('sel-shape-fill').value });
        endStyleGesture();
      });
      $('sel-shape-stroke').addEventListener('input', e => {
        beginStyleGesture();
        applyToSelectedShapes({ stroke: e.target.value });
      });
      $('sel-shape-stroke').addEventListener('change', endStyleGesture);
      $('sel-shape-stroke-width').addEventListener('input', e => {
        beginStyleGesture();
        $('sel-shape-stroke-width-val').textContent = e.target.value;
        applyToSelectedShapes({ strokeWidth: +e.target.value });
      });
      $('sel-shape-stroke-width').addEventListener('change', endStyleGesture);
      $('sel-shape-radius')?.addEventListener('input', e => {
        beginStyleGesture();
        $('sel-shape-radius-val').textContent = e.target.value;
        applyToSelectedShapes({ radius: +e.target.value });
      });
      $('sel-shape-radius')?.addEventListener('change', endStyleGesture);
      $('sel-shape-opacity').addEventListener('input', e => {
        beginStyleGesture();
        $('sel-shape-opacity-val').textContent = e.target.value;
        applyToSelectedShapes({ opacity: +e.target.value / 100 });
      });
      $('sel-shape-opacity').addEventListener('change', endStyleGesture);
    }

    const commitFrameEdit = () => {
      pushHistory();
      const newGroup = {
        x: +$('sel-x').value, y: +$('sel-y').value,
        width: Math.max(1, +$('sel-w').value),
        height: showH ? Math.max(1, +$('sel-h').value) : group.height,
        rotation: showRotation ? +$('sel-rotation').value : 0,
      };
      if (single) {
        const snap = { frame: singleFrame, size: single.size, points: single.type === 'stroke' ? single.points.map(p => ({ ...p })) : undefined };
        applyFrameToAnno(single, newGroup, snap, page, {});
      } else {
        const scaleX = group.width ? newGroup.width / group.width : 1;
        const scaleY = group.height ? newGroup.height / group.height : 1;
        const dx = newGroup.x - group.x, dy = newGroup.y - group.y;
        annos.forEach((anno, i) => {
          const f = frames[i];
          const itemFrame = {
            x: newGroup.x + (f.x - group.x) * scaleX,
            y: newGroup.y + (f.y - group.y) * scaleY,
            width: f.width * scaleX, height: f.height * scaleY, rotation: f.rotation,
          };
          const snap = { frame: f, size: anno.size, points: anno.type === 'stroke' ? anno.points.map(p => ({ ...p })) : undefined };
          applyFrameToAnno(anno, itemFrame, snap, page, {});
        });
      }
      updateSelectionBox();
    };
    ['sel-x', 'sel-y', 'sel-w', 'sel-h', 'sel-rotation'].forEach(id => {
      $(id)?.addEventListener('change', commitFrameEdit);
    });

    target.querySelectorAll('[data-align]').forEach(btn => {
      btn.addEventListener('click', () => alignSelection(btn.dataset.align));
    });
    target.querySelectorAll('[data-distribute]').forEach(btn => {
      btn.addEventListener('click', () => distributeSelection(btn.dataset.distribute));
    });
  }

  // ---------- History (undo / redo) ----------------------------------------

  function currentSnapshot () {
    return state.pages.map(p => deepClone(p.annotations));
  }

  function pushHistory () {
    state.history.push(currentSnapshot());
    if (state.history.length > 50) state.history.shift();
    state.future = [];
  }

  function undo () {
    if (state.history.length === 0) return;
    state.future.push(currentSnapshot());
    restoreSnapshot(state.history.pop());
  }

  function redo () {
    if (state.future.length === 0) return;
    state.history.push(currentSnapshot());
    restoreSnapshot(state.future.pop());
  }

  function restoreSnapshot (snap) {
    if (state.editingId) {
      const page = state.pages[state.selection.pageIndex];
      const el = page?.overlay.querySelector(`[data-id="${state.editingId}"]`);
      el?.classList.remove('is-editing');
      el?.querySelector('.text-anno__content')?.removeAttribute('contenteditable');
      state.editingId = null;
    }
    state.selection = { pageIndex: null, ids: new Set() };
    snap.forEach((annos, i) => {
      const page = state.pages[i];
      if (!page) return;
      page.overlay.querySelectorAll('.text-anno').forEach(el => el.remove());
      page.svg.querySelectorAll('[data-id]').forEach(el => el.remove());
      page.annotations = annos;
      annos.forEach(a => refreshAnno(page, a));
    });
    updateSelectionBox();
    updateSelectedPanel();
  }

  // ---------- Utilitaires ---------------------------------------------------

  function updateUI () {
    setTool(state.tool);
  }

  // ---------- Export PDF -----------------------------------------------------

  async function exportPDF () {
    if (state.pages.length === 0) return;
    if (state.editingId) commitEditing();

    $('btn-export').disabled = true;
    $('btn-export').textContent = 'Export…';

    try {
      await Promise.all([
        document.fonts.load('400 18px "Switzer"'),
        document.fonts.load('400 18px "Zodiak"'),
      ]);
      await document.fonts.ready;
    } catch {}

    try {
      const bytes = await buildExportedPdfBytes(state.pages, sourcePdfBytes);
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

  // ---------- Boot -------------------------------------------------------

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
