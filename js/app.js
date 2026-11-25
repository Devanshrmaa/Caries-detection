/* Caries Depth Checker: page setup, reading card, diagram photos and drawing. */
const $ = (s) => document.querySelector(s);
const TPLS = self.CARIES_TEMPLATES;
const E = window.CariesEngine;
E.select('molar', TPLS.molar);
// T is the reference tooth in use: the molar for diagrams and drawing, any template for X-rays.
// All templates share one 436x655 frame, so the canvases never change size.
let T = E.T, tplName = 'molar', PATHS = TPLS.molar.paths;
const W = T.W, H = T.H, N = W * H, K = 2;
const SEGS = [
  { code: 'RA1', w: .5, c: '#e4f0fc' }, { code: 'RA2', w: .5, c: '#c4ddf7' },
  { code: 'RA3', w: 1 / 3, c: '#fbefcf' }, { code: 'RB4', w: 1 / 3, c: '#f5dfa2' }, { code: 'RC5', w: 1 / 3, c: '#eccb79' },
  { code: 'RC6', w: .6, c: '#f6b7c3' }];
const CLS = {
  normal: { name: 'Sound tooth', col: 'var(--ok)', mg: 'Nothing to treat. Keep caries risk low: fluoride toothpaste twice a day, fewer sugary snacks and drinks, and routine check-ups.' },
  enamel: { name: 'Enamel caries', col: 'var(--enamel)', mg: 'Usually managed without drilling while the surface is intact: fluoride varnish, a fissure sealant on pits and fissures, or resin infiltration on smooth and proximal surfaces, with diet and plaque control. Review to confirm the lesion has arrested.' },
  dentin: { name: 'Dentin caries', col: 'var(--dentin)', mg: 'Once cavitated it needs a restoration. Remove carious dentin selectively down to firm dentin and restore with composite, glass ionomer or amalgam.' },
  pulp: { name: 'Pulp involvement', col: 'var(--pulp)', mg: 'Depends on the state of the pulp (symptoms, sensibility tests, radiograph): vital pulp therapy such as pulp capping or pulpotomy for a healthy or reversibly inflamed pulp, root canal treatment for irreversible pulpitis or necrosis, extraction if the tooth cannot be restored.' },
};
const DEEP_MG = 'Deep lesion: selective removal to soft dentin over the pulp, or stepwise excavation, with a liner and a well-sealed restoration lowers the risk of exposing the pulp.';
const SAMPLES = [
  ['dentin-middle', 'Dentin', 'labelled dentin'], ['sound', 'Sound', 'labelled normal'], ['enamel', 'Enamel', 'labelled enamel'],
  ['dentin-deep', 'Deep dentin', 'labelled dentin'], ['pulp', 'Pulp', 'labelled pulp'],
  ['tester-1', 'Tester 1', 'unlabelled tester'], ['tester-2', 'Tester 2', 'unlabelled tester'], ['tester-3', 'Tester 3', 'unlabelled tester']];

// ------------------------------------------------------------ canvases
const cv = ['c-base', 'c-tint', 'c-line', 'c-paint', 'c-les'].map(id => { const c = $('#' + id); c.width = W * K; c.height = H * K; return c.getContext('2d'); });
const [gBase, gTint, gLine, gPaint, gLes] = cv;
const off = document.createElement('canvas'); off.width = W; off.height = H;
const goff = off.getContext('2d');
function blit(g, imageData, smooth) {
  goff.putImageData(imageData, 0, 0);
  g.save(); g.imageSmoothingEnabled = smooth !== false; g.clearRect(0, 0, W * K, H * K); g.drawImage(off, 0, 0, W * K, H * K); g.restore();
}
function maskImage(fn) {
  const id = new ImageData(W, H), d = id.data;
  for (let i = 0; i < N; i++) { const c = fn(i); if (c) { d[4 * i] = c[0]; d[4 * i + 1] = c[1]; d[4 * i + 2] = c[2]; d[4 * i + 3] = c[3]; } }
  return id;
}
const TINT = { 1: [70, 150, 235, 70], 2: [238, 196, 96, 62], 3: [232, 80, 112, 80] };
function drawTint() { blit(gTint, maskImage(i => TINT[T.zones[i]])); }
drawTint();
// switch the reference tooth (the engine keeps each template once it has been built)
function useTemplate(name) {
  if (!TPLS[name]) name = 'molar';
  if (name === tplName) return;
  E.select(name, TPLS[name]);
  T = E.T; tplName = name; PATHS = TPLS[name].paths;
  drawTint();
}
function drawPaper(g, scale, lw, ink) {
  g.save(); g.fillStyle = '#fff'; g.fillRect(0, 0, W * scale, H * scale); g.scale(scale, scale);
  g.lineJoin = 'round'; g.lineCap = 'round'; g.strokeStyle = ink || '#1d1d1f'; g.lineWidth = lw;
  for (const [, d] of PATHS) g.stroke(new Path2D(d));
  g.restore();
}
$('#papersvg').innerHTML = PATHS.map(([, d]) => `<path d="${d}" fill="none" stroke="#1d1d1f" stroke-width="4" stroke-linejoin="round"/>`).join('');

// ------------------------------------------------------------ worker (falls back to the page thread)
// A few background threads (one per spare core, at most three): auto-fit tries the three reference
// teeth at once. Without workers (a page opened from disk, an old browser) everything runs here.
const pool = [], jobs = new Map();
let jobId = 0;
function startWorker() {
  const wk = { w: new Worker('js/worker.js'), busy: 0 };
  wk.ready = new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error('worker timeout')), 15000);
    wk.w.onmessage = (e) => {
      if (e.data.type === 'ready') { clearTimeout(t); ok(); return; }
      const j = jobs.get(e.data.id); if (j) { jobs.delete(e.data.id); j(e.data); }
    };
    wk.w.onerror = (e) => { clearTimeout(t); no(e); const i = pool.indexOf(wk); if (i >= 0) pool.splice(i, 1); for (const [, j] of jobs) j({ res: { ok: false, error: 'crash' }, fit: null }); jobs.clear(); };
  });
  wk.ready.catch(() => { const i = pool.indexOf(wk); if (i >= 0) pool.splice(i, 1); });
  wk.w.postMessage({ type: 'init' });
  return wk;
}
try {
  const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
  for (let i = 0; i < n; i++) pool.push(startWorker());
} catch (e) { pool.length = 0; }
// run a job on the least busy worker; null if there is none
async function onWorker(msg, transfer) {
  const wk = pool.slice().sort((a, b) => a.busy - b.busy)[0];
  if (!wk) return null;
  wk.busy++;
  try {
    await wk.ready;
    return await new Promise((ok) => { const id = ++jobId; jobs.set(id, ok); wk.w.postMessage(Object.assign(msg, { id }), transfer); });
  } catch (e) { return null; } finally { wk.busy--; }
}
async function analysePixels(w, h, data) {
  const out = await onWorker({ type: 'analyse', w, h, buf: data.buffer }, [data.buffer]);
  if (out) return out;
  await new Promise(r => setTimeout(r, 30));
  const was = tplName; useTemplate('molar');
  try { return runAnalysis(E, w, h, data); } finally { useTemplate(was); }
}
async function fitPixels(grey, w, h, M0, opts, tpl) {
  tpl = tpl || tplName;
  const keep = grey.slice(); // the buffer goes to the worker; keep a copy in case it fails
  const out = await onWorker({ type: 'fit', w, h, buf: grey.buffer, M0, tpl, opts }, [grey.buffer]);
  if (out) return out.fit || null;
  await new Promise(r => setTimeout(r, 30));
  const was = tplName; useTemplate(tpl);
  try { return E.xray.fit(keep, w, h, M0, opts); } finally { useTemplate(was); }
}

// ------------------------------------------------------------ state + rendering
const st = { mode: 'photo', photo: null, label: '', paint: new Uint8Array(N), undo: [], brush: 11, erase: false, drawRes: null, timer: 0 };
function setBusy(on, text) { $('#busy').classList.toggle('on', on); if (text) $('#busytext').textContent = text; }
function bandOf(r) {
  if (!r || !r.ok || r.pred === 'normal') return null;
  const S = r.depth;
  if (r.pred === 'pulp') return { i: 5, code: 'RC6', text: S >= 2 ? 'Extends into the pulp chamber' : 'Touches the roof of the pulp chamber' };
  if (r.pred === 'enamel') return S < .5 ? { i: 0, code: 'RA1', text: 'Outer half of enamel' } : { i: 1, code: 'RA2', text: S >= .9 ? 'Inner half of enamel, up to the junction' : 'Inner half of enamel' };
  if (S < 4 / 3) return { i: 2, code: 'RA3', text: 'Outer third of dentin' };
  if (S < 5 / 3) return { i: 3, code: 'RB4', text: 'Middle third of dentin' };
  return { i: 4, code: 'RC5', text: 'Inner third of dentin, close to the pulp' };
}
function whyOf(r) {
  const S = r.depth, x = st.mode === 'xray', n = x ? 'The dark area' : 'Shading';
  if (r.pred === 'normal') {
    if (x) return r.area ? 'Only specks are marked inside the outline, too little to call a lesion.' : 'No dark area is marked inside the tooth outline.';
    return r.area ? 'Only specks of shading inside the outline, too little to call a lesion.' : 'No shading inside the tooth outline.';
  }
  if (r.pred === 'enamel') return n + (S < .5 ? ' stays in the outer half of the enamel.' : S < .9 ? ' reaches the inner half of the enamel.' : ' reaches the enamel–dentin junction without spreading into dentin.');
  if (r.pred === 'dentin') return n + ' crosses the enamel–dentin junction and stops ' + (S < 5 / 3 ? 'well short of the pulp.' : 'just short of the pulp.');
  return n + (S >= 2 ? ' runs through dentin into the pulp chamber.' : ' runs through dentin and touches the pulp outline.');
}
function renderProbe(b, r) {
  const total = SEGS.reduce((a, s) => a + s.w, 0);
  let html = SEGS.map((s, i) => `<div class="seg2${b && b.i === i ? ' on' : ''}" style="flex:${s.w};background:${s.c}">${s.code}</div>`).join('');
  if (b) { const pos = r.pred === 'pulp' ? Math.max(2, Math.min(r.depth, total - .05)) : Math.min(r.depth, 1.99); html += `<span class="needle" style="left:${(pos / total * 100).toFixed(2)}%"></span>`; }
  $('#probe').innerHTML = html;
}
function renderReading(r, srcText) {
  $('#src').textContent = srcText;
  $('#findings').innerHTML = '';
  const warn = $('#warn');
  warn.classList.remove('on');
  if (!r.ok) {
    $('#cls').textContent = r.error === 'no_tooth' ? 'No tooth found' : 'Could not read this photo';
    $('#clsdot').style.color = 'var(--muted)';
    $('#bandline').textContent = r.error === 'no_tooth' ? 'Fit the whole diagram in the photo, with dark lines on light paper.' : 'Try another photo.';
    renderProbe(null); $('#tissues').innerHTML = ''; $('#why').textContent = ''; $('#mgmt').textContent = '';
    $('#meta').textContent = '';
    $('#rchip').innerHTML = '<span class="dot" style="color:#8d99a6"></span><span>No reading</span>';
    return;
  }
  const c = CLS[r.pred], b = bandOf(r);
  $('#cls').textContent = c.name;
  $('#clsdot').style.color = c.col;
  $('#bandline').innerHTML = b ? `${b.text} <span class="code">${b.code}</span>` : 'No lesion found';
  renderProbe(b, r);
  const les = r.pred !== 'normal';
  const inv = [['Enamel', les && r.a_en > 0, 'var(--enamel)'], ['Dentin', r.pred === 'dentin' || r.pred === 'pulp', 'var(--dentin)'], ['Pulp', r.pred === 'pulp', 'var(--pulp)']];
  $('#tissues').innerHTML = inv.map(([n, y, col]) => `<li class="${y ? 'yes' : 'no'}" style="${y ? 'color:' + col : ''}"><i></i><span style="color:var(--ink)">${n} ${y ? 'involved' : 'clear'}</span></li>`).join('');
  $('#why').textContent = whyOf(r);
  $('#mgmt').textContent = (r.pred === 'dentin' && b && b.code === 'RC5') ? DEEP_MG : c.mg;
  const parts = [`Depth index ${r.depth.toFixed(2)}`];
  if (r.quality != null && st.mode === 'photo') parts.push(`alignment ${Math.round(r.quality * 100)}%`);
  if (r.ms != null) parts.push(`${(r.ms / 1000).toFixed(1)} s`);
  $('#meta').textContent = parts.join(' · ');
  if (r.lowQuality) { warn.textContent = `The photo did not line up confidently (alignment ${Math.round(r.quality * 100)}%), so treat this reading with care. Retake it with the whole tooth in view, flat and evenly lit.`; warn.classList.add('on'); }
  $('#rchip').innerHTML = `<span class="dot" style="color:${r.pred === 'normal' ? '#e8eef3' : c.col}"></span><span>${c.name}${b ? ' · ' + b.code : ''}</span>`;
}
function renderLesion(grown, r) {
  gLes.clearRect(0, 0, W * K, H * K);
  if (!grown || !r.ok || r.pred === 'normal') return;
  blit(gLes, maskImage(i => {
    if (!grown[i]) return null;
    const edge = !grown[i - 1] || !grown[i + 1] || !grown[i - W] || !grown[i + W];
    if (r.pred === 'pulp' && T.pulpRing[i]) return [255, 40, 60, 235];
    return edge ? [225, 30, 50, 255] : [225, 30, 50, 60];
  }));
  if (r.deep) {
    const x = r.deep[0] * K, y = r.deep[1] * K;
    gLes.save(); gLes.lineWidth = 6; gLes.strokeStyle = '#fff'; gLes.beginPath(); gLes.arc(x, y, 18, 0, 7); gLes.stroke();
    gLes.lineWidth = 3; gLes.strokeStyle = '#d7263d'; gLes.beginPath(); gLes.arc(x, y, 18, 0, 7); gLes.stroke();
    gLes.fillStyle = '#d7263d'; gLes.beginPath(); gLes.arc(x, y, 4.5, 0, 7); gLes.fill(); gLes.restore();
  }
}
function applyToggles() {
  const les = $('#t-lesion').checked;
  $('#c-tint').style.display = $('#t-tissue').checked ? '' : 'none';
  $('#c-les').style.display = les ? '' : 'none';
  $('#c-paint').style.display = st.mode === 'xray' && !les ? 'none' : '';
  $('#c-line').style.display = st.mode === 'xray' ? '' : 'none';
}
$('#t-tissue').onchange = applyToggles; $('#t-lesion').onchange = applyToggles;

// how-it-works tiles
const sCtx = ['#s1', '#s2', '#s3', '#s4'].map(s => $(s).getContext('2d'));
const depthBase = maskImage(i => {
  const z = T.zones[i], S = T.S[i];
  if (z === 0) return [255, 255, 255, 255];
  if (z === 4) return [70, 76, 84, 255];
  if (S < 1) return [214 - 60 * S, 232 - 40 * S, 252 - 20 * S, 255];
  if (S < 2) { const t = S - 1; return [252 - 14 * t, 238 - 56 * t, 196 - 110 * t, 255]; }
  return [246, 170, 186, 255];
});
function renderSteps(p) {
  if (!p || !p.res.ok) return;
  const [a, b, c, d] = sCtx;
  a.fillStyle = '#fff'; a.fillRect(0, 0, W, H);
  const tc = document.createElement('canvas'); tc.width = p.tw; tc.height = p.th; tc.getContext('2d').putImageData(new ImageData(p.thumb, p.tw, p.th), 0, 0);
  const s = Math.min(W / p.tw, H / p.th); a.drawImage(tc, (W - p.tw * s) / 2, (H - p.th * s) / 2, p.tw * s, p.th * s);
  b.putImageData(new ImageData(p.view.slice(), W, H), 0, 0);
  const lines = maskImage(i => T.zones[i] === 4 ? [40, 120, 230, 150] : null);
  goff.putImageData(lines, 0, 0); b.drawImage(off, 0, 0);
  c.putImageData(maskImage(i => p.core[i] ? [215, 35, 55, 255] : p.grown[i] ? [120, 18, 30, 255] : T.zones[i] === 4 ? [205, 210, 216, 255] : [255, 255, 255, 255]), 0, 0);
  d.putImageData(depthBase, 0, 0);
  goff.putImageData(maskImage(i => p.grown[i] && (!p.grown[i - 1] || !p.grown[i + 1] || !p.grown[i - W] || !p.grown[i + W]) ? [215, 35, 55, 255] : null), 0, 0); d.drawImage(off, 0, 0);
  if (p.res.deep) { d.strokeStyle = '#d7263d'; d.lineWidth = 3; d.beginPath(); d.arc(p.res.deep[0], p.res.deep[1], 9, 0, 7); d.stroke(); }
}

// ------------------------------------------------------------ photo mode
function showPhoto(p) {
  st.photo = p;
  if (st.mode !== 'photo') return;
  $('#vlabel').textContent = p.label;
  if (p.res.ok) {
    blit(gBase, new ImageData(p.view.slice(), W, H));
    const ins = $('#inset'), ig = ins.getContext('2d');
    const tc = document.createElement('canvas'); tc.width = p.tw; tc.height = p.th; tc.getContext('2d').putImageData(new ImageData(p.thumb.slice(), p.tw, p.th), 0, 0);
    ins.height = Math.round(ins.width * p.th / p.tw); ig.drawImage(tc, 0, 0, ins.width, ins.height); ins.hidden = false;
  } else { drawPaper(gBase, K, 4, '#c7cdd3'); $('#inset').hidden = true; }
  gPaint.clearRect(0, 0, W * K, H * K);
  renderLesion(p.grown, p.res);
  renderReading(p.res, p.label);
}
// brightness of a small copy: diagram photos are mostly white paper, X-rays mostly dark
function imageStats(src) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(src, 0, 0, 64, 64);
  const d = g.getImageData(0, 0, 64, 64).data;
  let sum = 0, dark = 0;
  for (let i = 0; i < d.length; i += 4) { const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; sum += v; if (v < 80) dark++; }
  return { mean: sum / 4096, dark: dark / 4096 };
}
const looksLikeXray = (s) => s.dark > 0.15 && s.mean < 150;
const looksLikePaper = (s) => s.mean > 170 && s.dark < 0.08;
async function readDiagram(src) {
  const s = Math.min(1, 1800 / Math.max(src.width, src.height)), w = Math.round(src.width * s), h = Math.round(src.height * s);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(src, 0, 0, w, h);
  return analysePixels(w, h, g.getImageData(0, 0, w, h).data);
}
async function analyseBlob(blob, label, route) {
  setBusy(true, 'Reading the photo…');
  try {
    let bmp;
    try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) { bmp = await createImageBitmap(blob); }
    if (route && looksLikeXray(imageStats(bmp))) { // an X-ray picked in Diagram mode
      setBusy(false); setMode('xray');
      await xrLoad(blob, label + ' · opened as an X-ray');
      return;
    }
    const p = await readDiagram(bmp);
    p.label = label;
    showPhoto(p);
    renderSteps(p);
  } catch (e) {
    showPhoto({ res: { ok: false, error: 'crash' }, label });
  } finally { setBusy(false); }
}
function onFile(e) {
  const f = e.target.files && e.target.files[0];
  if (f) { document.querySelectorAll('.thumb').forEach(t => t.setAttribute('aria-current', 'false')); analyseBlob(f, 'Your photo', true); }
  e.target.value = '';
}
$('#f-cam').onchange = onFile; $('#f-pick').onchange = onFile;
$('#thumbs').innerHTML = SAMPLES.map(([id, name]) => `<button class="thumb" data-id="${id}" aria-current="false"><img src="samples/${id}-thumb.jpg" alt="" loading="lazy"><b>${name}</b></button>`).join('');
async function openSample(id) {
  const smp = SAMPLES.find(s => s[0] === id);
  document.querySelectorAll('.thumb').forEach(t => t.setAttribute('aria-current', String(t.dataset.id === id)));
  try {
    const resp = await fetch(`samples/${id}.jpg`);
    if (!resp.ok) throw new Error(resp.status);
    await analyseBlob(await resp.blob(), `Dataset photo · ${smp[2]}`);
  } catch (e) {
    setBusy(false);
    $('#vlabel').textContent = 'Take or choose a photo to begin';
    renderReading({ ok: false, error: 'none' }, 'Sample photos could not be loaded here.');
    $('#cls').textContent = 'Ready';
    $('#bandline').textContent = 'Take or choose a photo of the shaded diagram.';
  }
}
$('#thumbs').onclick = (e) => { const b = e.target.closest('.thumb'); if (b) { if (st.mode !== 'photo') setMode('photo'); openSample(b.dataset.id); } };

// ------------------------------------------------------------ draw mode
function paintImage() { return maskImage(i => st.paint[i] ? [44, 34, 32, 235] : null); }
function drawAnalyse() {
  if (st.mode !== 'draw') return;
  const t0 = performance.now(), r = E.analyseDrawing(st.paint);
  r.ms = performance.now() - t0; r.quality = null;
  st.drawRes = r;
  renderLesion(r.maps.grown, r);
  renderReading(r, 'Your drawing');
}
function scheduleDraw() { clearTimeout(st.timer); st.timer = setTimeout(drawAnalyse, 120); }
function stamp(x, y, val) {
  const r = st.brush, x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(W - 1, Math.ceil(x + r)), y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(H - 1, Math.ceil(y + r));
  for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) if ((xx - x) ** 2 + (yy - y) ** 2 <= r * r) st.paint[yy * W + xx] = val;
  gPaint.save();
  gPaint.globalCompositeOperation = val ? 'source-over' : 'destination-out';
  gPaint.fillStyle = 'rgba(44,34,32,.92)'; gPaint.beginPath(); gPaint.arc(x * K, y * K, r * K, 0, 7); gPaint.fill(); gPaint.restore();
}
let drag = null;
const stack = $('#stack');
function toCanon(e) { const b = stack.getBoundingClientRect(); return [(e.clientX - b.left) * W / b.width, (e.clientY - b.top) * H / b.height]; }
stack.addEventListener('pointerdown', (e) => {
  if (st.mode === 'xray') { xrDown(e); return; }
  if (st.mode !== 'draw') return;
  e.preventDefault(); stack.setPointerCapture(e.pointerId);
  st.undo.push(st.paint.slice()); if (st.undo.length > 20) st.undo.shift();
  drag = toCanon(e); stamp(drag[0], drag[1], st.erase ? 0 : 1); scheduleDraw();
});
stack.addEventListener('pointermove', (e) => {
  if (st.mode === 'xray') { xrMove(e); return; }
  if (!drag) return;
  const [x, y] = toCanon(e), d = Math.hypot(x - drag[0], y - drag[1]), n = Math.max(1, Math.ceil(d / (st.brush * .4)));
  for (let k = 1; k <= n; k++) stamp(drag[0] + (x - drag[0]) * k / n, drag[1] + (y - drag[1]) * k / n, st.erase ? 0 : 1);
  drag = [x, y]; scheduleDraw();
});
const endDrag = (e) => { if (st.mode === 'xray') { xrUp(e); return; } if (drag) { drag = null; scheduleDraw(); } };
stack.addEventListener('pointerup', endDrag); stack.addEventListener('pointercancel', endDrag);
function redrawPaint() { blit(gPaint, paintImage()); }
$('#b-shade').onclick = () => { st.erase = false; $('#b-shade').setAttribute('aria-pressed', 'true'); $('#b-erase').setAttribute('aria-pressed', 'false'); };
$('#b-erase').onclick = () => { st.erase = true; $('#b-erase').setAttribute('aria-pressed', 'true'); $('#b-shade').setAttribute('aria-pressed', 'false'); };
$('#b-size').oninput = (e) => { st.brush = +e.target.value; };
$('#b-undo').onclick = () => { if (st.undo.length) { st.paint = st.undo.pop(); redrawPaint(); drawAnalyse(); } };
$('#b-clear').onclick = () => { st.undo.push(st.paint.slice()); st.paint = new Uint8Array(N); redrawPaint(); drawAnalyse(); };
const PRESETS = { enamel: [212, 26, 16, .8], dentin: [248, 34, 22, 1.5], deep: [178, 30, 20, 1.78], pulp: [232, 30, 18, 2.45] };
document.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
  const [xc, w0, w1, sMax] = PRESETS[b.dataset.preset];
  st.undo.push(st.paint.slice());
  const p = new Uint8Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, S = T.S[i];
    if (T.zones[i] === 0 || S > sMax || y > 330) continue;
    const hw = w0 + (w1 - w0) * Math.min(1, S / sMax);
    if (Math.abs(x - xc) <= hw) p[i] = 1;
  }
  st.paint = p; redrawPaint(); drawAnalyse();
});

function setMode(m) {
  st.mode = m;
  useTemplate(m === 'xray' ? (xr.tplUsed || 'molar') : 'molar'); // diagrams and drawing always use the molar
  $('#m-photo').setAttribute('aria-pressed', String(m === 'photo'));
  $('#m-xray').setAttribute('aria-pressed', String(m === 'xray'));
  $('#m-draw').setAttribute('aria-pressed', String(m === 'draw'));
  $('#work').classList.toggle('drawmode', m === 'draw');
  $('#work').classList.toggle('xraymode', m === 'xray');
  stack.classList.toggle('drawing', m !== 'photo');
  stack.classList.toggle('moving', m === 'xray' && xr.tool === 'move');
  if (m === 'xray') stack.tabIndex = 0; else stack.removeAttribute('tabindex');
  $('#xhelp').hidden = !(m === 'xray' && xr.img);
  applyToggles();
  if (m === 'xray') { $('#inset').hidden = true; xrShow(); }
  else if (m === 'draw') {
    $('#inset').hidden = true;
    $('#vlabel').textContent = 'Reference molar · shade a lesion';
    drawPaper(gBase, K, 4);
    redrawPaint(); drawAnalyse();
  } else if (st.photo) showPhoto(st.photo);
  else { gPaint.clearRect(0, 0, W * K, H * K); gLes.clearRect(0, 0, W * K, H * K); drawPaper(gBase, K, 4, '#c7cdd3'); $('#vlabel').textContent = 'Take or choose a photo to begin'; }
}
$('#m-photo').onclick = () => setMode('photo');
$('#m-xray').onclick = () => setMode('xray');
$('#m-draw').onclick = () => setMode('draw');
