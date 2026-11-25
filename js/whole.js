/* Whole X-ray view, for panoramic (OPG) and bite-wing images: the full image with the bite line and
 * metal marked, a tap on a tooth crops it (upper teeth turned crown-up) and opens it in the one-tooth
 * view, and a chart keeps the teeth checked so far. */
const wv = {
  img: null, w: 0, h: 0, type: null, label: '',
  grey: null, gw: 0, gh: 0, gs: 1, // scan copy: gs = scan pixels per image pixel
  occ: null, arches: null, met: null, pos: null, quality: null,
  view: null, // screen (CSS px) = image px * s + (tx, ty)
  teeth: new Map(), ai: null, midAdj: 0, cropping: null,
};
const wc = $('#wcanvas'), wg = wc.getContext('2d');
const KINDNAME = { molar: 'molar', premolar: 'premolar', incisor: 'front tooth' };
const CLSCOL = { normal: '#e8eef3', enamel: '#7fb6f0', dentin: '#e2b85a', pulp: '#ff7d93' };
const FDI_ORDER = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28, 38, 37, 36, 35, 34, 33, 32, 31, 41, 42, 43, 44, 45, 46, 47, 48];

// size and position of each reference tooth, to place a crop on it
const GEOM = {};
function tplGeom(name) {
  if (!GEOM[name]) {
    const was = tplName; useTemplate(name);
    const r = E.xray.refs();
    GEOM[name] = { cw: 2 * r.crownHW, len: r.box[3] - r.box[1], cx: (r.box[0] + r.box[2]) / 2, my: (r.box[1] + r.box[3]) / 2 };
    useTemplate(was);
  }
  return GEOM[name];
}

// ------------------------------------------------------------ loading and scanning
async function wvLoad(src, label, type) {
  setBusy(true, type === 'panoramic' ? 'Reading the panoramic X-ray…' : 'Reading the bite-wing…');
  try {
    const s = Math.min(1, 3000 / Math.max(src.width, src.height)), w = Math.round(src.width * s), h = Math.round(src.height * s);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(src, 0, 0, w, h);
    const gs = Math.min(1, 1600 / Math.max(w, h)), gw = Math.round(w * gs), gh = Math.round(h * gs);
    const sc = document.createElement('canvas'); sc.width = gw; sc.height = gh;
    const sg = sc.getContext('2d', { willReadFrequently: true }); sg.drawImage(c, 0, 0, gw, gh);
    const px = sg.getImageData(0, 0, gw, gh).data, grey = new Float32Array(gw * gh);
    for (let i = 0; i < gw * gh; i++) grey[i] = 0.299 * px[4 * i] + 0.587 * px[4 * i + 1] + 0.114 * px[4 * i + 2];
    await new Promise(r => setTimeout(r, 20));
    const S = DentalScan, occ = S.biteLine(grey, gw, gh, type);
    const pano = type === 'panoramic', Lc = pano ? 0.08 : 0.26;
    // bite-wing crowns are big: sample below the cusps (a molar's cusps would look like a gap) and above
    // the pulp horns
    const arches = occ ? S.arches(grey, gw, gh, occ, Lc, pano ? null : [0.18, 0.38], pano ? null : 30) : null;
    const lo = S.percentile(grey, 2), hi = S.percentile(grey, 98);
    Object.assign(wv, { img: c, w, h, type, label, grey, gw, gh, gs, occ, arches,
      met: occ ? S.metal(grey, gw, gh, occ, type) : { items: [] },
      pos: pano ? S.positioning(occ, gw, gh) : null,
      quality: { range: hi - lo, low: hi - lo < 70 },
      teeth: new Map(), ai: null, midAdj: 0, cropping: null });
    wv.metalC = metalCanvas(wv.met);
    $('#w-mid').value = 0;
    xr.ctx = null;
    st.xview = 'whole';
    if (st.mode !== 'xray') setMode('xray'); else { setXView('whole'); wvShow(); }
    $('#share').hidden = false;
  } finally { setBusy(false); }
}
function wvShow() {
  if (!wv.img) { setXView('tooth'); xrShow(); return; }
  setXView('whole');
  $('#vlabel').textContent = wv.label;
  $('#w-midrow').hidden = $('#w-midnote').hidden = wv.type !== 'panoramic';
  $('#rchip').innerHTML = `<span class="dot" style="color:#8d99a6"></span><span>${wv.teeth.size ? wv.teeth.size + ' checked' : 'Tap a tooth'}</span>`;
  requestAnimationFrame(() => { wvResize(); if (!wv.view) wvFitView(); wvDraw(); });
  wvCard();
}

// ------------------------------------------------------------ drawing
function wvResize() {
  const r = wc.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const cw = Math.max(1, Math.round(r.width * dpr)), ch = Math.max(1, Math.round(r.height * dpr));
  if (wc.width !== cw || wc.height !== ch) { wc.width = cw; wc.height = ch; }
}
function wvFitView() {
  const r = wc.getBoundingClientRect(), s = Math.min(r.width / wv.w, r.height / wv.h) * 0.98;
  wv.view = { s, tx: (r.width - wv.w * s) / 2, ty: (r.height - wv.h * s) / 2 };
}
const g2i = (v) => v / wv.gs; // scan pixels -> image pixels
function wvDraw() {
  if (!wv.img || !wv.view) return;
  const dpr = window.devicePixelRatio || 1, { s, tx, ty } = wv.view;
  wg.setTransform(1, 0, 0, 1, 0, 0);
  wg.fillStyle = '#060b10'; wg.fillRect(0, 0, wc.width, wc.height);
  wg.setTransform(dpr * s, 0, 0, dpr * s, dpr * tx, dpr * ty);
  wg.imageSmoothingEnabled = true; wg.imageSmoothingQuality = 'high';
  wg.drawImage(wv.img, 0, 0, wv.w, wv.h);
  const px = 1 / s; // one screen pixel in image pixels
  // bite line and midline
  if ($('#w-bite').checked && wv.occ) {
    wg.save(); wg.setLineDash([10 * px, 7 * px]); wg.lineWidth = 2.2 * px; wg.strokeStyle = 'rgba(95,225,255,.9)';
    wg.beginPath();
    for (let x = 0; x <= wv.gw; x += 6) { const y = DentalScan.biteAt(wv.occ, x).y; x ? wg.lineTo(g2i(x), g2i(y)) : wg.moveTo(g2i(x), g2i(y)); }
    wg.stroke();
    if (wv.type === 'panoramic' && wv.arches) {
      const mx = g2i(wvMid('upper')), by = g2i(DentalScan.biteAt(wv.occ, wvMid('upper')).y);
      wg.strokeStyle = 'rgba(95,225,255,.6)'; wg.beginPath(); wg.moveTo(mx, by - wv.h * 0.28); wg.lineTo(mx, by + wv.h * 0.28); wg.stroke();
    }
    wg.restore();
  }
  // metal objects
  if ($('#w-metal').checked && wv.met) {
    const col = { filling: '#ffd34d', 'root-filling': '#ff9f43', implant: '#ff5c7a', other: '#c8ccd0' };
    wg.save(); wg.lineWidth = 2 * px;
    for (const it of wv.met.items) {
      wg.strokeStyle = col[it.kind];
      wg.strokeRect(g2i(it.x0) - 3 * px, g2i(it.y0) - 3 * px, g2i(it.x1 - it.x0) + 6 * px, g2i(it.y1 - it.y0) + 6 * px);
    }
    wg.restore();
  }
  // AI marks
  if ($('#w-ai').checked && wv.ai) drawAIBoxes(wg, wv.ai, wv.w, wv.h, px);
  // teeth checked
  for (const t of wv.teeth.values()) {
    const r = 13 * px;
    wg.beginPath(); wg.arc(t.x, t.y, r, 0, 7);
    wg.fillStyle = 'rgba(6,11,16,.82)'; wg.fill();
    wg.lineWidth = 3 * px; wg.strokeStyle = CLSCOL[t.pred] || '#fff'; wg.stroke();
    wg.fillStyle = '#fff'; wg.font = `600 ${11 * px}px "Instrument Sans", system-ui, sans-serif`; wg.textAlign = 'center'; wg.textBaseline = 'middle';
    wg.fillText(t.fdi ? String(t.fdi) : '✓', t.x, t.y + 0.5 * px);
  }
  // crop rectangle being drawn
  if (wv.cropping && wv.cropping.r) {
    const [x0, y0, x1, y1] = wv.cropping.r;
    wg.save(); wg.fillStyle = 'rgba(0,0,0,.5)';
    wg.beginPath(); wg.rect(0, 0, wv.w, wv.h); wg.rect(x0, y0, x1 - x0, y1 - y0); wg.fill('evenodd');
    wg.lineWidth = 2 * px; wg.strokeStyle = '#fff'; wg.strokeRect(x0, y0, x1 - x0, y1 - y0); wg.restore();
  }
}
function drawAIBoxes(g, list, w, h, px) {
  g.save(); g.lineWidth = 2.5 * px; g.font = `600 ${12 * px}px "Instrument Sans", system-ui, sans-serif`; g.textBaseline = 'bottom';
  list.forEach((f, i) => {
    const b = f.box; if (!b) return;
    const x0 = Math.min(b.x0, b.x1) * w, x1 = Math.max(b.x0, b.x1) * w, y0 = Math.min(b.y0, b.y1) * h, y1 = Math.max(b.y0, b.y1) * h;
    if (!(x1 - x0 > 0 && y1 - y0 > 0)) return;
    g.setLineDash([8 * px, 5 * px]); g.strokeStyle = '#c084fc'; g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    g.setLineDash([]);
    const tag = String(i + 1), tw = g.measureText(tag).width + 8 * px;
    g.fillStyle = '#c084fc'; g.fillRect(x0, y0 - 16 * px, tw, 16 * px);
    g.fillStyle = '#12051f'; g.fillText(tag, x0 + 4 * px, y0 - 2 * px);
  });
  g.restore();
}
window.addEventListener('resize', () => { if (st.mode === 'xray' && st.xview === 'whole' && wv.img) { wvResize(); wvFitView(); wvDraw(); } });
for (const id of ['#w-bite', '#w-metal', '#w-ai']) $(id).onchange = wvDraw;

// ------------------------------------------------------------ gestures: drag to pan, pinch or scroll to zoom, tap a tooth
const wp = new Map();
let wgst = null;
function wvLocal(e) { const r = wc.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
function wvToImage([sx, sy]) { const { s, tx, ty } = wv.view; return [(sx - tx) / s, (sy - ty) / s]; }
wc.addEventListener('pointerdown', (e) => {
  if (!wv.img) return;
  e.preventDefault(); wc.setPointerCapture(e.pointerId);
  wp.set(e.pointerId, wvLocal(e));
  const pts = [...wp.values()];
  if (wv.cropping) { const p = wvToImage(pts[0]); wv.cropping.a = p; wv.cropping.r = null; return; }
  wgst = { v0: Object.assign({}, wv.view), pts: pts.map(p => p.slice()), t0: performance.now(), moved: 0, multi: pts.length > 1 };
});
wc.addEventListener('pointermove', (e) => {
  if (!wp.has(e.pointerId)) return;
  wp.set(e.pointerId, wvLocal(e));
  const pts = [...wp.values()];
  if (wv.cropping && wv.cropping.a) {
    const [ax, ay] = wv.cropping.a, [bx, by] = wvToImage(pts[0]), cl = (v, m) => Math.max(0, Math.min(m, v));
    wv.cropping.r = [cl(Math.min(ax, bx), wv.w), cl(Math.min(ay, by), wv.h), cl(Math.max(ax, bx), wv.w), cl(Math.max(ay, by), wv.h)];
    wvDraw(); return;
  }
  if (!wgst) return;
  if (pts.length !== wgst.pts.length) { wgst = { v0: Object.assign({}, wv.view), pts: pts.map(p => p.slice()), t0: wgst.t0, moved: wgst.moved + 99, multi: true }; return; }
  const v0 = wgst.v0;
  if (pts.length === 1) {
    const dx = pts[0][0] - wgst.pts[0][0], dy = pts[0][1] - wgst.pts[0][1];
    wgst.moved = Math.max(wgst.moved, Math.hypot(dx, dy));
    if (wgst.moved > 6) wv.view = { s: v0.s, tx: v0.tx + dx, ty: v0.ty + dy };
  } else {
    const [a0, a1] = wgst.pts, [b0, b1] = pts;
    const m0 = [(a0[0] + a1[0]) / 2, (a0[1] + a1[1]) / 2], m1 = [(b0[0] + b1[0]) / 2, (b0[1] + b1[1]) / 2];
    const f = Math.hypot(b1[0] - b0[0], b1[1] - b0[1]) / Math.max(1, Math.hypot(a1[0] - a0[0], a1[1] - a0[1]));
    const s = Math.max(0.05, Math.min(40, v0.s * f)), k = s / v0.s;
    wv.view = { s, tx: m1[0] - (m0[0] - v0.tx) * k, ty: m1[1] - (m0[1] - v0.ty) * k };
    wgst.moved = 99;
  }
  wvDraw();
});
function wvUp(e) {
  if (!wp.has(e.pointerId)) return;
  const p = wp.get(e.pointerId);
  wp.delete(e.pointerId);
  if (wv.cropping) { $('#a-cropok').hidden = !wv.cropping.r; return; }
  if (wgst && !wgst.multi && wgst.moved <= 6 && performance.now() - wgst.t0 < 600 && e.type === 'pointerup') {
    const [ix, iy] = wvToImage(p);
    if (ix >= 0 && iy >= 0 && ix < wv.w && iy < wv.h) wvTap(ix, iy);
  }
  if (!wp.size) wgst = null;
}
wc.addEventListener('pointerup', wvUp); wc.addEventListener('pointercancel', wvUp);
wc.addEventListener('wheel', (e) => {
  if (!wv.img) return;
  e.preventDefault();
  const [sx, sy] = wvLocal(e), v = wv.view, f = Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.004);
  const s = Math.max(0.05, Math.min(40, v.s * f)), k = s / v.s;
  wv.view = { s, tx: sx - (sx - v.tx) * k, ty: sy - (sy - v.ty) * k };
  wvDraw();
}, { passive: false });
wc.addEventListener('keydown', (e) => {
  if (!wv.img) return;
  const v = wv.view, step = e.shiftKey ? 60 : 20;
  const act = { ArrowLeft: () => { v.tx += step; }, ArrowRight: () => { v.tx -= step; }, ArrowUp: () => { v.ty += step; }, ArrowDown: () => { v.ty -= step; },
    '+': () => zoomBy(1.2), '=': () => zoomBy(1.2), '-': () => zoomBy(1 / 1.2) }[e.key];
  if (!act) return;
  e.preventDefault(); act(); wvDraw();
});
function zoomBy(f) {
  const r = wc.getBoundingClientRect(), v = wv.view, cx = r.width / 2, cy = r.height / 2, s = Math.max(0.05, Math.min(40, v.s * f)), k = s / v.s;
  wv.view = { s, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
}
$('#w-fit').onclick = () => { if (wv.img) { wvFitView(); wvDraw(); } };

// ------------------------------------------------------------ which tooth, and the crop around it
function wvMid(jaw) {
  const A = wv.arches && wv.arches[jaw];
  if (!A) return wv.gw / 2;
  const half = Math.max((wv.occ.archR - wv.occ.archL) / 2, wv.gw * 0.2);
  return A.mid + wv.midAdj * half;
}
function wvArches() {
  if (!wv.arches) return null;
  return { upper: Object.assign({}, wv.arches.upper, { mid: wvMid('upper') }), lower: Object.assign({}, wv.arches.lower, { mid: wvMid('lower') }) };
}
$('#w-mid').oninput = (e) => { wv.midAdj = +e.target.value; wvDraw(); };

// the two gaps between crowns on either side of x, if they make a tooth of a sensible width
function wvGaps(jaw, gx, expect) {
  const A = wv.arches && wv.arches[jaw];
  if (!A || !A.dips.length) return null;
  const left = A.dips.filter(d => d < gx).pop(), right = A.dips.find(d => d > gx);
  if (left == null || right == null) return null;
  const wdt = right - left;
  if (expect && (wdt < 0.7 * expect || wdt > 1.6 * expect)) return null;
  return { cx: (left + right) / 2, w: wdt, index: A.dips.filter(d => d < gx).length };
}
// a tooth at the edge of a bite-wing: one gap, and the image edge on the other side
function wvEdgeGap(jaw, gx) {
  const A = wv.arches && wv.arches[jaw];
  if (!A || !A.dips.length) return null;
  const left = A.dips.filter(d => d < gx).pop(), right = A.dips.find(d => d > gx);
  if (left == null && right != null) return { cx: right / 2, w: right, index: 0 };
  if (right == null && left != null) return { cx: (left + wv.gw) / 2, w: wv.gw - left, index: A.dips.length };
  return null;
}
function wvTap(ix, iy) {
  const gx = ix * wv.gs, gy = iy * wv.gs, S = DentalScan, pano = wv.type === 'panoramic';
  const occ = wv.occ || { fit: { p0: wv.gh / 2, p1: 0, p2: 0, mid: wv.gw / 2, half: wv.gw / 2 }, x0: 0, sx: 1, path: [wv.gh / 2] };
  const info = S.toothAt(occ, gx, gy, wv.type, pano ? wvArches() : null), jaw = info.upper ? 'upper' : 'lower';
  // tooth kind and crown width (scan pixels)
  let kind = info.kind, crownW = info.crownW, gaps;
  if (pano) gaps = wvGaps(jaw, gx, crownW);
  else {
    // a bite-wing shows premolars and molars: the gaps either side give the width, the width the kind
    gaps = wvGaps(jaw, gx, null) || wvEdgeGap(jaw, gx);
    if (gaps && (gaps.w < 0.15 * wv.gh || gaps.w > 0.65 * wv.gh)) gaps = null;
    crownW = gaps ? gaps.w : wv.gh * 0.35;
    kind = crownW < 0.3 * wv.gh ? 'premolar' : 'molar';
  }
  let cx = gx;
  if (gaps) { cx = gaps.cx; crownW = gaps.w; }
  const g = tplGeom(kind), L = crownW * g.len / g.cw;
  const b = S.biteAt(occ, cx), th = Math.atan(b.slope || 0);
  // the tooth's long axis is square to the bite line; the middle of the tooth is half a tooth away
  const dir = info.upper ? -1 : 1, nx = -Math.sin(th) * dir, ny = Math.cos(th) * dir;
  const mx = g2i(cx + nx * (0.5 * L + 0.01 * L)), my = g2i(b.y + ny * (0.5 * L + 0.01 * L));
  // crop: 1.5 tooth lengths tall, the reference frame's shape, upright with the crown at the top
  const Li = g2i(L), Hc = 1.5 * Li, Wc = Hc * 436 / 655, k = Math.min(2, 900 / Hc);
  const out = document.createElement('canvas'); out.width = Math.round(Wc * k); out.height = Math.round(Hc * k);
  const og = out.getContext('2d');
  og.fillStyle = '#000'; og.fillRect(0, 0, out.width, out.height);
  og.translate(out.width / 2, out.height / 2); og.scale(k, k); og.rotate(-th + (info.upper ? Math.PI : 0)); og.translate(-mx, -my);
  og.imageSmoothingQuality = 'high'; og.drawImage(wv.img, 0, 0);
  // the metal found on the whole image, cut out the same way
  const mc = document.createElement('canvas'); mc.width = out.width; mc.height = out.height;
  if (wv.metalC) { const mg = mc.getContext('2d'); mg.setTransform(og.getTransform()); mg.imageSmoothingEnabled = false; mg.drawImage(wv.metalC, 0, 0, wv.w, wv.h); }
  // where the reference tooth starts: its middle on the crop's middle, its length one tooth length;
  // then measured on the crop itself (the gaps either side of the crown, and the crown's biting edge)
  let place = { cx: g.cx, cy: g.my, s: g.len / (Li * k), rot: 0 };
  const box = measureCrown(out, place, kind);
  if (box) place = placeOnBox(kind, box, out.width, out.height);
  let key, title;
  if (pano) { key = String(info.fdi); title = `Tooth ${info.fdi} · ${KINDNAME[kind]} (estimated)`; }
  else {
    const n = gaps ? gaps.index : null;
    key = (info.upper ? 'U' : 'L') + (n != null ? n : Math.round(cx / crownW));
    title = `${info.upper ? 'Upper' : 'Lower'} tooth${n != null ? ', ' + ordinal(n) + ' from the left' : ''}`;
  }
  const ctx = { key, fdi: info.fdi || null, upper: info.upper, kind, x: ix, y: iy, type: wv.type };
  xrOpen(out, `${title} · from the ${pano ? 'panoramic X-ray' : 'bite-wing'}`, {
    // the crown is what a whole X-ray shows clearly (roots sit in bone, neighbours touch): fit it alone
    ctx, place, box, tpl: kind, tplOnly: pano ? null : ['molar', 'premolar'], crownOnly: true, localOnly: true, metal: mc,
  });
}
// the metal mask from the whole-image scan as a canvas (opaque where there is metal)
function metalCanvas(met) {
  if (!met || !met.mask) return null;
  const c = document.createElement('canvas'); c.width = met.mw; c.height = met.mh;
  const g = c.getContext('2d'), id = g.createImageData(met.mw, met.mh);
  for (let i = 0; i < met.mask.length; i++) if (met.mask[i]) { id.data[4 * i] = id.data[4 * i + 1] = id.data[4 * i + 2] = 255; id.data[4 * i + 3] = 255; }
  g.putImageData(id, 0, 0);
  return c;
}
// Measure the crown on the crop: along a band across the middle of the crown, the dark gaps on either
// side (searched away from the middle, where the pulp is); down the middle, the biting edge (bright
// crown below, dark gap above). Returns a placement that puts the reference crown on what was measured,
// or null if nothing clear was found.
function measureCrown(cv, place, kind) {
  const W2 = cv.width, H2 = cv.height, gd = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W2, H2).data;
  const I = (x, y) => { const i = 4 * (Math.max(0, Math.min(H2 - 1, Math.round(y))) * W2 + Math.max(0, Math.min(W2 - 1, Math.round(x)))); return 0.299 * gd[i] + 0.587 * gd[i + 1] + 0.114 * gd[i + 2]; };
  const was = tplName; useTemplate(kind);
  const R = E.xray.refs();
  // the reference crown's own top along the same middle band (a molar dips between its cusps there)
  let tsum = 0, tn = 0;
  for (let x = Math.round(R.midX - 0.15 * R.crownHW * 2); x <= Math.round(R.midX + 0.15 * R.crownHW * 2); x++) {
    for (let y = 0; y < T.H; y++) if (T.sil[y * T.W + x]) { tsum += y; tn++; break; }
  }
  const topMid = tn ? tsum / tn : R.box[1];
  useTemplate(was);
  const s = place.s, ch = R.cervY - R.top, gw = (2 * R.crownHW) / s, gh = ch / s; // crown width and height, crop px
  const cx0 = W2 / 2 + (R.midX - place.cx) / s, yTop0 = H2 / 2 + (topMid - place.cy) / s;
  // horizontal profile across the middle of the crown
  const yb = yTop0 + 0.45 * gh, prof = [];
  for (let x = 0; x < W2; x++) { let sum = 0, n = 0; for (let y = yb - 0.12 * gh; y <= yb + 0.12 * gh; y += 2) { sum += I(x, y); n++; } prof.push(sum / n); }
  const sm = prof.map((v, i) => { let a = 0, n = 0; for (let k = -3; k <= 3; k++) { const j = i + k; if (j >= 0 && j < W2) { a += prof[j]; n++; } } return a / n; });
  const argmin = (a, b) => { let bi = -1, bv = Infinity; for (let x = Math.max(0, Math.round(a)); x <= Math.min(W2 - 1, Math.round(b)); x++) if (sm[x] < bv) { bv = sm[x]; bi = x; } return bi; };
  const L = argmin(cx0 - 0.8 * gw, cx0 - 0.32 * gw), Rr = argmin(cx0 + 0.32 * gw, cx0 + 0.8 * gw);
  // the crown's brightness: its brightest part near the middle (the middle itself can be the pulp)
  let mid = -Infinity; for (let x = Math.max(0, Math.round(cx0 - 0.3 * gw)); x <= Math.min(W2 - 1, Math.round(cx0 + 0.3 * gw)); x++) mid = Math.max(mid, sm[x]);
  const rng = Math.max(...sm) - Math.min(...sm);
  if (L < 0 || Rr < 0 || Math.min(mid - sm[L], mid - sm[Rr]) < 0.12 * rng) return null;
  const width = Rr - L, cxm = (L + Rr) / 2;
  if (width < 0.7 * gw || width > 1.4 * gw) return null;
  // biting edge: going up the middle of the crown, where bright below turns dark above
  let best = -Infinity, ym = yTop0;
  const d = Math.max(2, 0.06 * gh);
  for (let y = yTop0 - 0.35 * gh; y <= yTop0 + 0.35 * gh; y += 1) {
    let a = 0, b = 0, n = 0;
    for (let x = cxm - 0.15 * width; x <= cxm + 0.15 * width; x += 2) { a += I(x, y + d); b += I(x, y - d); n++; }
    const v = (a - b) / n;
    if (v > best) { best = v; ym = y; }
  }
  if (best < 0.1 * rng) ym = yTop0;
  return { cx: cxm, w: width, top: ym }; // crop pixels
}
// a placement that puts a reference tooth's crown on a measured crown box (crop pixels)
function placeOnBox(kind, box, W2, H2) {
  const was = tplName; useTemplate(kind);
  const R = E.xray.refs();
  let tsum = 0, tn = 0;
  for (let x = Math.round(R.midX - 0.3 * R.crownHW); x <= Math.round(R.midX + 0.3 * R.crownHW); x++) {
    for (let y = 0; y < T.H; y++) if (T.sil[y * T.W + x]) { tsum += y; tn++; break; }
  }
  const topMid = tn ? tsum / tn : R.box[1];
  useTemplate(was);
  const ns = (2 * R.crownHW) / box.w; // template px per crop px, so the crown is as wide as measured
  return { cx: R.midX - (box.cx - W2 / 2) * ns, cy: topMid - (box.top - H2 / 2) * ns, s: ns, rot: 0 };
}
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

// a tooth number picked in the chart: tap where that tooth should be
function wvTapFdi(fdi) {
  if (!wv.occ || !wv.arches || wv.type !== 'panoramic') return;
  const q = Math.floor(fdi / 10), pos = fdi % 10, upper = q <= 2, jaw = upper ? 'upper' : 'lower';
  const A = wvArches()[jaw], ws = DentalScan.WIDTHS[jaw];
  const r = A.k * (ws.slice(0, pos - 1).reduce((a, c) => a + c, 0) + ws[pos - 1] / 2);
  const gx = A.mid + ((q === 1 || q === 4) ? -r : r);
  if (gx < 0 || gx >= wv.gw) return;
  const b = DentalScan.biteAt(wv.occ, gx), gy = b.y + (upper ? -1 : 1) * wv.gh * 0.06;
  wvTap(gx / wv.gs, gy / wv.gs);
}

// ------------------------------------------------------------ results of the teeth checked
function wvRecord(ctx, r) {
  if (!ctx) return;
  const b = bandOf(r);
  const snap = { img: xr.img, iw: xr.iw, ih: xr.ih, p: Object.assign({}, xr.p), s0: xr.s0, mask: xr.mask, maskC: xr.maskC, maskG: xr.maskG,
    label: xr.label, tplUsed: xr.tplUsed, tplPick: xr.tplPick, crownOnly: xr.crownOnly, localOnly: xr.localOnly, tplOnly: xr.tplOnly, aligned: xr.aligned, auto: xr.auto, ctx, metal: xr.metal, box: xr.box };
  wv.teeth.set(ctx.key, Object.assign({}, ctx, { pred: r.ok ? r.pred : null, code: b ? b.code : '', depth: r.depth, snap }));
}
function wvReopen(key) {
  const t = wv.teeth.get(key);
  if (!t) return;
  Object.assign(xr, t.snap, { undo: [], res: null });
  useTemplate(xr.tplUsed);
  st.xview = 'tooth'; setXView('tooth');
  xrSyncTooth(); xrShow();
}
function wvCard() {
  $('#w-src').textContent = wv.label;
  $('#w-title').textContent = wv.type === 'panoramic' ? 'Panoramic X-ray (OPG)' : 'Bite-wing X-ray';
  const n = wv.teeth.size;
  $('#w-lead').textContent = n ? `${n} ${n === 1 ? 'tooth' : 'teeth'} checked. Tap another tooth on the image to check it.` : 'Tap a tooth on the image to check it for decay.';
  const items = [];
  const kinds = (wv.met ? wv.met.items : []).reduce((a, it) => (a[it.kind] = (a[it.kind] || 0) + 1, a), {});
  const parts = [];
  if (kinds.filling) parts.push(`${kinds.filling} ${kinds.filling === 1 ? 'filling or crown' : 'fillings or crowns'}`);
  if (kinds['root-filling']) parts.push(`${kinds['root-filling']} root canal ${kinds['root-filling'] === 1 ? 'filling' : 'fillings'}`);
  if (kinds.implant) parts.push(`${kinds.implant} possible ${kinds.implant === 1 ? 'implant or post' : 'implants or posts'}`);
  if (parts.length) items.push(['Metal seen: ' + parts.join(', '), 'Metal stops X-rays and shows flat white; it is outlined on the image (yellow: fillings and crowns, orange: root fillings, red: implants or posts). Tap a tooth with a filling to check for decay along its edges.', false]);
  else items.push(['No metal fillings seen', 'Tooth-coloured fillings are often only slightly brighter than enamel, so they are not counted.', false]);
  if (!wv.occ) items.push(['Bite line not found', 'Upper and lower teeth could not be told apart, so a tap assumes the top half is the upper jaw. Use Adjust image to crop or turn the X-ray.', true]);
  for (const [, text] of (wv.pos && wv.pos.notes) || []) items.push(['Positioning', text, true]);
  if (wv.type === 'panoramic' && wv.pos && !wv.pos.notes.length) items.push(['Positioning looks right', 'The bite line curves up gently towards the back, as it should on a panoramic X-ray taken with the head level.', false]);
  if (wv.quality && wv.quality.low) items.push(['Low contrast', 'The image is grey and flat, so early decay can be missed. Try Adjust image, then Enhance contrast.', true]);
  if (wv.type === 'panoramic') items.push(['Normal anatomy that can look like disease', 'The maxillary sinus over the upper back teeth, the mental foramen near the lower premolar roots, the mandibular canal, the tongue and soft palate, the hyoid bone, and the spine over the chin. See "Reading a panoramic X-ray" below.', false]);
  if (wv.type === 'bitewing') items.push(['Bite-wings show crowns, not root tips', 'They are the best X-ray for decay between back teeth and for the bone level between them; lesions at the root tips need a periapical X-ray.', false]);
  const esc = (t) => t.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m]);
  $('#w-findings').innerHTML = items.map(([t, d, w]) => `<li class="${w ? 'caution' : ''}"><b>${esc(t)}</b><span>${esc(d)}</span></li>`).join('');
  // chart
  const pano = wv.type === 'panoramic';
  $('#w-chart').hidden = !pano;
  if (pano) {
    const cell = (fdi) => {
      const t = wv.teeth.get(String(fdi));
      const c = t && t.pred ? CLSCOL[t.pred] : '';
      return `<button class="tcell${t ? ' done' : ''}" data-fdi="${fdi}" style="${c ? '--tc:' + c : ''}" aria-label="Tooth ${fdi}${t && t.pred ? ': ' + CLS[t.pred].name : ''}">${fdi}</button>`;
    };
    const row = (list) => `<div class="trow">${list.map(cell).join('')}</div>`;
    $('#w-chart').innerHTML = `<div class="chartjaw"><span>Upper</span>${row([18, 17, 16, 15, 14, 13, 12, 11])}${row([21, 22, 23, 24, 25, 26, 27, 28])}</div>
      <div class="chartjaw"><span>Lower</span>${row([48, 47, 46, 45, 44, 43, 42, 41])}${row([31, 32, 33, 34, 35, 36, 37, 38])}</div>
      <p class="hint chartkey"><i style="--tc:${CLSCOL.normal}"></i>sound <i style="--tc:${CLSCOL.enamel}"></i>enamel <i style="--tc:${CLSCOL.dentin}"></i>dentin <i style="--tc:${CLSCOL.pulp}"></i>pulp</p>`;
  }
  const list = [...wv.teeth.values()];
  $('#w-checked').innerHTML = list.map(t => `<li><button class="linkish" data-key="${t.key}"><span class="dot" style="color:${CLSCOL[t.pred] || '#8d99a6'}"></span>${t.fdi ? 'Tooth ' + t.fdi : (t.upper ? 'Upper' : 'Lower') + ' tooth'}: ${t.pred ? CLS[t.pred].name : 'not read'}${t.code ? ' · ' + t.code : ''}</button></li>`).join('');
}
$('#w-chart').onclick = (e) => {
  const b = e.target.closest('.tcell'); if (!b) return;
  const fdi = b.dataset.fdi;
  if (wv.teeth.has(fdi)) wvReopen(fdi); else wvTapFdi(+fdi);
};
$('#w-checked').onclick = (e) => { const b = e.target.closest('[data-key]'); if (b) wvReopen(b.dataset.key); };
$('#w-next').onclick = () => {
  if (!wv.img) return;
  if (wv.type === 'panoramic') { const next = FDI_ORDER.find(f => !wv.teeth.has(String(f))); if (next) wvTapFdi(next); return; }
  // bite-wing: the next crown along the upper row, then the lower row
  for (const jaw of ['upper', 'lower']) {
    const A = wv.arches && wv.arches[jaw];
    if (!A) continue;
    for (let i = 0; i + 1 < A.dips.length; i++) {
      const cx = (A.dips[i] + A.dips[i + 1]) / 2, key = (jaw === 'upper' ? 'U' : 'L') + (i + 1);
      if (wv.teeth.has(key)) continue;
      const b = DentalScan.biteAt(wv.occ, cx);
      wvTap(cx / wv.gs, (b.y + (jaw === 'upper' ? -1 : 1) * wv.gh * 0.15) / wv.gs);
      return;
    }
  }
};
// back to the whole image from a tooth
$('#w-back').onclick = () => { if (!wv.img) return; xr.ctx = null; st.xview = 'whole'; setXView('whole'); wvShow(); };
// change the number of the tooth being checked (panoramic): moves its record and refits with the right shape
(function () {
  const sel = $('#w-fdi');
  sel.innerHTML = FDI_ORDER.map(f => `<option value="${f}">${f}</option>`).join('');
  sel.onchange = () => {
    if (!xr.ctx || !xr.ctx.fdi) return;
    const fdi = +sel.value, old = xr.ctx.key, pos = fdi % 10;
    wv.teeth.delete(old);
    xr.ctx = Object.assign({}, xr.ctx, { fdi, key: String(fdi), kind: DentalScan.KIND[pos - 1] });
    xr.label = xr.label.replace(/^Tooth \d+ · [a-z ]+ \(estimated\)/, `Tooth ${fdi} · ${KINDNAME[xr.ctx.kind]}`);
    $('#vlabel').textContent = xr.label;
    xrPickTooth(xr.ctx.kind);
  };
})();
