/* X-ray mode: one tooth from a radiograph or a photo of a cut tooth. */
// ------------------------------------------------------------ X-ray mode
// The image sits under the fixed reference outline. Alignment is one affine map from image pixels to
// the template frame, kept as move / size / turn / width (+ shear from auto-fit) so the sliders stay
// meaningful. The marked lesion lives in image pixels, so it moves with the image when the fit changes.
const xr = {
  img: null, iw: 0, ih: 0, mask: null, maskC: null, maskG: null, undo: [], label: '',
  p: null, s0: 1, tool: 'move', brush: 9, sens: 6, auto: false, aligned: false, res: null, timer: 0, found: null,
  tplPick: 'auto', tplUsed: 'molar', crownOnly: false, localOnly: false,
  ctx: null, // set when the tooth was cropped from a whole X-ray: { key, fdi, upper, kind, x, y, type }
  tplOnly: null, // the reference teeth Auto may choose from (bite-wings show no front teeth)
};
function xrM() {
  const { cx, cy, s, rot, asp, k, flip } = xr.p, co = Math.cos(rot), si = Math.sin(rot), f = flip ? -1 : 1;
  const u00 = s * asp, u01 = s * k, u11 = s;
  const a = co * u00 * f, b = co * u01 - si * u11, c = si * u00 * f, d = si * u01 + co * u11, hx = xr.iw / 2, hy = xr.ih / 2;
  return [a, b, cx - a * hx - b * hy, c, d, cy - c * hx - d * hy];
}
function xrInv(M) {
  const [a, b, e, c, d, f] = M, det = a * d - b * c;
  return [d / det, -b / det, (b * f - d * e) / det, -c / det, a / det, (c * e - a * f) / det];
}
function xrSetFromM(M) { // inverse of xrM: affine (image -> template) to the slider parameters
  let a = M[0], b = M[1], c = M[3], d = M[4];
  const flip = a * d - b * c < 0;
  if (flip) { a = -a; c = -c; }
  const rot = Math.atan2(c, a), sx = Math.hypot(a, c), co = Math.cos(rot), si = Math.sin(rot);
  const k1 = co * b + si * d, sy = -si * b + co * d, hx = xr.iw / 2, hy = xr.ih / 2;
  xr.p = { cx: M[0] * hx + M[1] * hy + M[2], cy: M[3] * hx + M[4] * hy + M[5], s: sy, asp: sx / sy, k: k1 / sy, rot, flip };
}
function xrContain() {
  xr.s0 = Math.min(W * 0.92 / xr.iw, H * 0.92 / xr.ih);
  xr.p = { cx: W / 2, cy: H / 2, s: xr.s0, asp: 1, k: 0, rot: 0, flip: false };
}
const wrapDeg = (r) => { let d = r * 180 / Math.PI % 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return d; };
function xrSyncSliders() {
  if (!xr.p) return;
  $('#x-size').value = Math.log2(xr.p.s / xr.s0).toFixed(2);
  $('#x-rot').value = wrapDeg(xr.p.rot).toFixed(1);
  $('#x-width').value = Math.log2(xr.p.asp).toFixed(2);
}
function xrDrawOutline() {
  gLine.clearRect(0, 0, W * K, H * K);
  gLine.save(); gLine.scale(K, K); gLine.lineJoin = 'round'; gLine.lineCap = 'round';
  for (const [col, lw] of [['rgba(0,0,0,.55)', 4.2], ['#5fe1ff', 2]]) {
    gLine.strokeStyle = col; gLine.lineWidth = lw;
    for (const [, d] of PATHS) gLine.stroke(new Path2D(d));
  }
  gLine.restore();
}
function xrRender() {
  gBase.save(); gBase.setTransform(1, 0, 0, 1, 0, 0); gBase.fillStyle = '#000'; gBase.fillRect(0, 0, W * K, H * K); gBase.restore();
  gPaint.clearRect(0, 0, W * K, H * K);
  if (!xr.img) return;
  const [a, b, e, c, d, f] = xrM();
  for (const [g, src, alpha] of [[gBase, xr.img, 1], [gPaint, xr.maskC, .45]]) {
    g.save(); g.setTransform(K * a, K * c, K * b, K * d, K * e, K * f);
    g.globalAlpha = alpha; g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0); g.restore();
  }
  if (xr.ai && xr.ai.length) { // boxes from the AI review, in image pixels
    gPaint.save(); gPaint.setTransform(K * a, K * c, K * b, K * d, K * e, K * f);
    drawAIBoxes(gPaint, xr.ai, xr.iw, xr.ih, 1 / (K * Math.sqrt(Math.abs(a * d - b * c))));
    gPaint.restore();
  }
}
function xrRedrawMask() {
  const id = new ImageData(xr.iw, xr.ih), dd = id.data, m = xr.mask;
  for (let i = 0; i < m.length; i++) if (m[i]) { dd[4 * i] = 255; dd[4 * i + 1] = 59; dd[4 * i + 2] = 48; dd[4 * i + 3] = 255; }
  xr.maskG.putImageData(id, 0, 0);
}
// image into the template frame: grey levels plus where the image covers the frame
function xrFrame() {
  const [a, b, e, c, d, f] = xrM();
  goff.save(); goff.setTransform(1, 0, 0, 1, 0, 0); goff.clearRect(0, 0, W, H);
  goff.setTransform(a, c, b, d, e, f); goff.imageSmoothingEnabled = true; goff.drawImage(xr.img, 0, 0); goff.restore();
  const px = goff.getImageData(0, 0, W, H).data, g = new Float32Array(N), valid = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    g[i] = 0.299 * px[4 * i] + 0.587 * px[4 * i + 1] + 0.114 * px[4 * i + 2];
    valid[i] = px[4 * i + 3] > 200 ? 1 : 0;
  }
  goff.clearRect(0, 0, W, H);
  let metal = null;
  if (xr.metal) { // metal found on the whole X-ray, carried over with the crop
    goff.save(); goff.setTransform(a, c, b, d, e, f); goff.imageSmoothingEnabled = false; goff.drawImage(xr.metal, 0, 0, xr.iw, xr.ih); goff.restore();
    const mp = goff.getImageData(0, 0, W, H).data; metal = new Uint8Array(N);
    for (let i = 0; i < N; i++) metal[i] = mp[4 * i + 3] > 100 ? 1 : 0;
    goff.clearRect(0, 0, W, H);
  }
  return { g, valid, metal };
}
function xrMaskToTemplate() {
  const Mi = xrInv(xrM()), out = new Uint8Array(N), { iw, ih, mask } = xr;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = Math.round(Mi[0] * x + Mi[1] * y + Mi[2]), v = Math.round(Mi[3] * x + Mi[4] * y + Mi[5]);
    if (u >= 0 && v >= 0 && u < iw && v < ih && mask[v * iw + u]) out[y * W + x] = 1;
  }
  return out;
}
function xrMaskFromTemplate(tm) {
  const M = xrM(), { iw, ih } = xr, m = new Uint8Array(iw * ih);
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
    const u = Math.round(M[0] * x + M[1] * y + M[2]), v = Math.round(M[3] * x + M[4] * y + M[5]);
    if (u >= 0 && v >= 0 && u < W && v < H && tm[v * W + u]) m[y * iw + x] = 1;
  }
  return m;
}
function xrFind(manual) {
  if (!xr.img) return;
  if (manual) { xr.undo.push(xr.mask.slice()); if (xr.undo.length > 20) xr.undo.shift(); }
  const fr = xrFrame(), k = 0.62 - 0.05 * xr.sens, r = E.xray.findDark(fr.g, fr.valid, k, fr.metal, xrDarkOpts());
  xr.mask = r ? xrMaskFromTemplate(r.mask) : new Uint8Array(xr.iw * xr.ih);
  xr.auto = true; xr.found = r;
  xrRedrawMask(); xrRender(); xrClassify();
  const note = $('#x-marknote');
  if (!r) note.textContent = 'The image does not cover the crown of the outline. Line the tooth up first.';
  else if (!r.area) note.textContent = 'No dark area found that opens onto the surface. Raise Sensitivity, or shade it with the brush.';
  else note.textContent = 'Marked in red. Check it against the image and fix it with Shade or Erase.';
}
// what the detector should know about the image: cut from a whole X-ray, and whether it is an X-ray
function xrDarkOpts() { return { crop: !!xr.ctx, xray: !!xr.ctx || xr.kind === 'xray' }; }
function xrClassify() {
  if (!xr.img || st.mode !== 'xray') return;
  const t0 = performance.now(), r = E.analyseDrawing(xrMaskToTemplate());
  r.ms = performance.now() - t0; r.quality = null;
  xr.res = r;
  renderLesion(r.maps.grown, r);
  renderReading(r, xr.label);
  renderFindings(xrFindings(r));
  if (xr.ctx && typeof wvRecord === 'function') wvRecord(xr.ctx, r);
  // circle a root tip flagged as dark, so the note has something to point at
  for (const a of (xr.info && xr.info.apex) || []) if (a.covered && a.dark) {
    gLes.save(); gLes.setLineDash([12, 9]); gLes.lineWidth = 5; gLes.strokeStyle = '#fff'; gLes.beginPath(); gLes.arc(a.at[0] * K, a.at[1] * K, 34 * K, 0, 7); gLes.stroke();
    gLes.lineWidth = 3; gLes.strokeStyle = '#d7263d'; gLes.stroke(); gLes.restore();
  }
}
// What the radiology atlas says to look at beside the depth: which surface, burn-out, fillings,
// root tips and image quality. Each item is [title, text, caution?].
const SITE = {
  occlusal: ['On the biting (occlusal) surface', 'Fissure decay shows on a radiograph only late, once it is well into dentin, because the whole crown lies over it. It is usually larger than it looks.'],
  proximal: ['On a side (proximal) surface', 'Bite-wing radiographs show decay between teeth best; on other views it is easy to miss or to underrate.'],
  cervical: ['At the neck of the tooth', 'Compare with the other side of the tooth and the neighbours: a dark band at the neck on both sides is burn-out, not decay. Check it clinically.'],
};
function xrFindings(r) {
  xr.info = null;
  if (!xr.aligned) return [['Line the tooth up first', 'The checks for fillings, burn-out, root tips and image quality run once the outline sits on the tooth.', false]];
  const fr = xrFrame(), les = r.pred !== 'normal';
  const info = E.xray.inspect(fr.g, fr.valid, les ? r.maps.core : null, 0.62 - 0.05 * xr.sens, fr.metal, xrDarkOpts());
  if (!info) return [];
  xr.info = info;
  const out = [], deep = r.pred === 'pulp' || (r.pred === 'dentin' && r.depth >= 5 / 3);
  const secondary = les && info.secondary;
  if (secondary) out.push(['Dark area against a filling', 'A very bright (radiopaque) filling or crown with the marked dark area right against it: possible secondary (recurrent) decay. Some liners and tooth-coloured fillings also look dark, so check it clinically.', true]);
  else if (les && info.site) out.push([...SITE[info.site.site], info.site.site === 'cervical']);
  if (info.burnout) out.push(['Cervical burn-out', 'Both sides of the tooth neck look dark. The neck is covered by neither enamel nor bone, so X-rays pass easily and it shows dark on most radiographs. Find dark areas leaves it out.', false]);
  if (info.filling && !secondary) out.push(['Filling or crown seen', 'A very bright (radiopaque) area. Bite-wings also show whether its edges seal well or overhang.', false]);
  if (info.rootFilling) out.push(['Root canal filling seen', 'The tooth has had root canal treatment, so the pulp reading does not mean the same as for an untreated tooth.', false]);
  const ap = xr.crownOnly ? [] : info.apex.filter(a => a.covered); // a crown-only fit cannot place the root tips
  if (ap.some(a => a.dark)) out.push(['Dark area at a root tip', 'Possible apical periodontitis, which often follows decay into the pulp; a sharp border with a bright rim suggests a long-standing lesion. A radiograph can only call it possible: anatomy such as the mental foramen can look the same (an intact ligament space around the tip argues against a lesion).', true]);
  else if (deep && ap.length) out.push(['Root tips', 'No dark area seen around the root tips. Early inflammation shows nothing on a radiograph, and no radiograph can show whether the pulp is alive.', false]);
  else if (deep && xr.crownOnly && xr.ctx && xr.ctx.type === 'panoramic') out.push(['Look at the root tips', 'Only the crown is lined up here. Go back to the whole X-ray and look at the bone around this tooth\'s root tips: a dark halo there can mean apical periodontitis.', false]);
  else if (deep) out.push(['Root tips not in view', 'A periapical radiograph shows the root tips and the bone around them; a bite-wing does not.', false]);
  if (xr.ctx && xr.ctx.type === 'panoramic' && (!les || r.pred === 'enamel')) out.push(['Panoramic X-rays miss early decay', 'Small lesions in enamel and between teeth are often not visible on a panoramic X-ray. A bite-wing is the X-ray for early decay between back teeth.', false]);
  const im = info.image, p = xr.p;
  if (im && im.lowContrast) out.push(['Low contrast', 'The image is grey and flat. Early lesions can be missed and lesions look smaller than they are.', true]);
  else if (im && im.light) out.push(['Image looks light', 'Under-exposed or under-developed: lesions look smaller than they are and early ones can be missed.', true]);
  else if (im && im.dark) out.push(['Image looks dark', 'Over-exposed: burn-out at the neck is stronger and dark areas can look bigger than they are.', true]);
  if (Math.abs(Math.log2(p.asp)) > 0.3 || Math.abs(p.k) > 0.25) out.push(['Tooth stretched to fit', 'The outline had to be stretched a lot. A bent film or an angled beam distorts teeth, so the depth reading is less reliable.', true]);
  return out;
}
function renderFindings(list) {
  const esc = (t) => t.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m]);
  $('#findings').innerHTML = list.map(([t, d, w]) => `<li class="${w ? 'caution' : ''}"><b>${esc(t)}</b><span>${esc(d)}</span></li>`).join('');
}
function xrChanged(aligned = true) {
  xr.aligned = aligned; // any move by hand counts as lining the tooth up
  xrRender(); xrSyncSliders();
  clearTimeout(xr.timer);
  xr.timer = setTimeout(() => { if (xr.auto && xr.aligned) xrFind(false); else xrClassify(); }, xr.auto ? 220 : 90);
}
function xrIdle() {
  xrDrawOutline(); xrRender(); gLes.clearRect(0, 0, W * K, H * K);
  $('#vlabel').textContent = 'Choose an X-ray or tooth photo to begin';
  renderReading({ ok: false, error: 'none' }, 'X-ray or tooth photo');
  $('#cls').textContent = 'Ready';
  $('#bandline').textContent = 'Choose an X-ray or a photo of a cut tooth.';
  $('#rchip').innerHTML = '<span class="dot" style="color:#8d99a6"></span><span>No image yet</span>';
}
function xrShow() {
  $('#xhelp').hidden = !xr.img;
  if (!xr.img) { xrIdle(); return; }
  $('#vlabel').textContent = xr.label;
  xrDrawOutline(); xrRender(); xrSyncSliders(); xrClassify();
}
async function xrAutoFit(local) {
  const sc = Math.min(1, 420 / Math.max(xr.iw, xr.ih)), w = Math.max(8, Math.round(xr.iw * sc)), h = Math.max(8, Math.round(xr.ih * sc));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(xr.img, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data, grey = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) grey[i] = 0.299 * px[4 * i] + 0.587 * px[4 * i + 1] + 0.114 * px[4 * i + 2];
  const sx = w / xr.iw, sy = h / xr.ih, img = xr.img;
  let M0 = null;
  if (local) { const A = xrM(); M0 = [A[0] / sx, A[1] / sy, A[2], A[3] / sx, A[4] / sy, A[5], 0, 0, 1]; }
  const opts = { crownOnly: !!xr.crownOnly, localOnly: !!xr.localOnly, snap: !!xr.localOnly && !!M0 };
  // "Auto" tries each reference tooth and keeps the one whose outline fits best
  const pool = xr.tplOnly || XTEETH.map(t => t[0]);
  const names = xr.tplPick === 'auto' ? (pool.includes(tplName) ? [tplName] : []).concat(pool.filter(n => n !== tplName)) : [xr.tplPick];
  // a template whose outline sits well inside or outside the tooth's edges loses points; another
  // template has to beat the first one clearly to replace it
  const score = (f) => f.q * (1 - Math.min(0.5, (f.gap || 0) / 40));
  // all reference teeth are fitted at once, each on its own background thread when there are several;
  // with a measured crown (a tooth cut from a whole X-ray) each starts from its own placement on it
  const startFor = (name) => {
    if (!local || !xr.box) return M0;
    const P = placeOnBox(name, xr.box, xr.iw, xr.ih), keep = xr.p;
    xr.p = Object.assign({ asp: 1, k: 0, flip: false }, P);
    const A = xrM(); xr.p = keep;
    return [A[0] / sx, A[1] / sy, A[2], A[3] / sx, A[4] / sy, A[5], 0, 0, 1];
  };
  const fits = await Promise.all(names.map(name => fitPixels(grey.slice(), w, h, startFor(name), opts, name)));
  let best = null;
  names.forEach((name, i) => {
    const fit = fits[i];
    // snapped crowns: the higher contrast across the outline wins; otherwise the first template stands
    // unless another one fits really well
    if (fit && fit.snap) { if (!best || fit.q > best.fit.q + 0.02) best = { fit, name }; return; }
    const strong = fit && fit.M && fit.ok && fit.q >= 0.85 && (fit.gap || 0) <= 6;
    if (fit && fit.M && (!best || (strong && score(fit) > score(best.fit) + 0.03))) best = { fit, name };
  });
  if (!best) return { q: 0, ok: false };
  useTemplate(best.name);
  xr.tplUsed = best.name; xrSyncTooth();
  if (best.fit.ok && xr.img === img) { const M = best.fit.M; xrSetFromM([M[0] * sx, M[1] * sy, M[2], M[3] * sx, M[4] * sy, M[5]]); }
  return best.fit;
}
// which reference tooth is in use; "Auto" shows what it picked
const XTEETH = [['molar', 'Molar'], ['premolar', 'Premolar'], ['incisor', 'Front tooth']];
function xrSyncTooth() {
  for (const b of document.querySelectorAll('#x-tooth button')) b.setAttribute('aria-pressed', String(b.dataset.t === xr.tplPick));
  const used = XTEETH.find(t => t[0] === (xr.tplUsed || tplName));
  $('#x-toothnote').textContent = xr.tplPick === 'auto' && used ? `Auto picked: ${used[1].toLowerCase()}.` : '';
}
async function xrPickTooth(t) {
  xr.tplPick = t; xrSyncTooth();
  if (t !== 'auto') { useTemplate(t); xr.tplUsed = t; }
  if (st.mode !== 'xray') return;
  xrDrawOutline();
  if (!xr.img) return;
  setBusy(true, 'Lining up the tooth…');
  try {
    const fit = await xrAutoFit(true);
    xrFitNote(fit);
    if (fit.ok && !xr.mask.some(v => v)) xr.auto = true;
    xrChanged(fit.ok || xr.aligned);
  } finally { setBusy(false); }
}
$('#x-tooth').onclick = (e) => { const b = e.target.closest('button[data-t]'); if (b) xrPickTooth(b.dataset.t); };
function xrFitNote({ q, ok, edge, gap, snap }, placed) {
  $('#x-fitnote').textContent = !ok && placed ? 'Could not snap the outline to the tooth, so it is placed where the tooth should be. Check it, and drag or size it if it is off.'
    : ok && snap ? 'Snapped the crown outline to the tooth. Check it, and drag or size it if it is off.'
    : ok && edge ? `Lined up the crown: its outline sits on the tooth's edges (within ${Math.max(1, Math.round(gap))} px). Check it, and adjust it if needed.`
    : !ok ? 'Could not line up a tooth. Drag and zoom so the crown sits roughly inside the outline, then press Auto-fit again.'
    : q >= 0.85 ? `Lined up a tooth (outline overlap ${Math.round(q * 100)}%). Wrong tooth? Drag and zoom onto the one you want, then press Auto-fit again.`
    : `Lined up roughly (outline overlap ${Math.round(q * 100)}%). Adjust it by hand, or drag and zoom onto the tooth you want and press Auto-fit again.`;
}
async function xrLoad(blob, label, route) {
  let bmp;
  try {
    try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) { bmp = await createImageBitmap(blob); }
  } catch (e) {
    xr.img = null; setMode('xray'); xrIdle();
    $('#cls').textContent = 'Could not open this image';
    $('#bandline').textContent = 'Try a JPEG or PNG photo.';
    return;
  }
  return xrOpen(bmp, label, { route });
}
// Open an image (canvas or bitmap) in the one-tooth view.
// opts.route: a diagram photo may be passed on to Diagram mode; opts.ctx: tooth cropped from a whole
// X-ray; opts.place: starting placement {cx, cy, s, rot}; opts.tpl: reference tooth to use;
// opts.crownOnly / opts.localOnly / opts.tplOnly: passed to the fit.
async function xrOpen(src, label, opts) {
  opts = opts || {};
  setBusy(true, 'Lining up the tooth…');
  try {
    const s = Math.min(1, 1200 / Math.max(src.width, src.height)), iw = Math.max(1, Math.round(src.width * s)), ih = Math.max(1, Math.round(src.height * s));
    const c = document.createElement('canvas'); c.width = iw; c.height = ih;
    c.getContext('2d').drawImage(src, 0, 0, iw, ih);
    const mc = document.createElement('canvas'); mc.width = iw; mc.height = ih;
    Object.assign(xr, { img: c, iw, ih, mask: new Uint8Array(iw * ih), maskC: mc, maskG: mc.getContext('2d'), undo: [], label, auto: true, res: null,
      ctx: opts.ctx || null, crownOnly: !!opts.crownOnly, localOnly: !!opts.localOnly, tplOnly: opts.tplOnly || null, ai: null, metal: opts.metal || null,
      box: opts.box ? { cx: opts.box.cx * s, w: opts.box.w * s, top: opts.box.top * s } : null,
      kind: opts.kind || (opts.ctx ? 'xray' : null) });
    if (opts.tpl) { xr.tplPick = opts.tpl; useTemplate(opts.tpl); xr.tplUsed = opts.tpl; }
    else if (opts.ctx) xr.tplPick = 'auto';
    xrSyncTooth();
    xrContain();
    // place.s is template pixels per pixel of the image passed in; the copy above is s times smaller
    if (opts.place) xr.p = { cx: opts.place.cx, cy: opts.place.cy, s: opts.place.s / s, rot: opts.place.rot || 0, asp: 1, k: 0, flip: !!opts.place.flip };
    st.xview = 'tooth';
    if (st.mode !== 'xray') setMode('xray'); else setXView('tooth');
    xrDrawOutline(); xrRender();
    await new Promise(r => setTimeout(r, 30));
    const fit = await xrAutoFit(!!opts.place);
    // a tooth picked out of a whole X-ray keeps its starting placement if the fit fails: it is close
    xr.aligned = fit.ok || !!opts.place;
    if (opts.route && !fit.ok && looksLikePaper(imageStats(c))) { // a photo of the printed diagram
      const p = await readDiagram(c);
      if (p.res.ok && p.res.quality >= 0.6) {
        p.label = label + ' · opened as a diagram photo';
        xr.img = null; st.photo = p; setMode('photo'); renderSteps(p);
        return;
      }
    }
    xrFitNote(fit, !!opts.place);
    $('#xhelp').hidden = false;
    $('#vlabel').textContent = label;
    xrDrawOutline(); xrSyncSliders();
    setXView('tooth');
    if (xr.aligned) xrFind(false);
    else {
      xr.auto = false; xrRender(); xrClassify();
      $('#x-marknote').textContent = 'Line the tooth up first. Auto-fit looks for decay once the outline fits.';
    }
    $('#share').hidden = false;
  } catch (e) {
    xr.img = null; xrIdle();
    $('#cls').textContent = 'Could not open this image';
    $('#bandline').textContent = 'Try a JPEG or PNG photo.';
  } finally { setBusy(false); }
}

// alignment controls
$('#x-size').oninput = (e) => { if (!xr.img) return; xr.p.s = xr.s0 * 2 ** +e.target.value; xrChanged(); };
$('#x-rot').oninput = (e) => { if (!xr.img) return; xr.p.rot = +e.target.value * Math.PI / 180; xrChanged(); };
$('#x-width').oninput = (e) => { if (!xr.img) return; xr.p.asp = 2 ** +e.target.value; xrChanged(); };
$('#x-mirror').onclick = () => { if (!xr.img) return; xr.p.flip = !xr.p.flip; xrChanged(); };
$('#x-reset').onclick = () => { if (!xr.img) return; xrContain(); $('#x-fitnote').textContent = ''; xrChanged(false); };
$('#x-fit').onclick = async () => {
  if (!xr.img) return;
  setBusy(true, 'Lining up the tooth…');
  try {
    const fit = await xrAutoFit(true), was = xr.aligned;
    xrFitNote(fit);
    if (fit.ok && !xr.mask.some(v => v)) xr.auto = true; // nothing marked yet: look for decay once fitted
    xrChanged(fit.ok || was);
  } finally { setBusy(false); }
};

// marking controls
function xrTool(t) {
  xr.tool = t;
  for (const id of ['move', 'shade', 'erase']) $('#x-' + id).setAttribute('aria-pressed', String(id === t));
  stack.classList.toggle('moving', st.mode === 'xray' && t === 'move');
  $('#xhelp').textContent = t === 'move' ? 'Drag to move · pinch or scroll to size' : t === 'shade' ? 'Shade over the decay' : 'Erase what is not decay';
}
$('#x-move').onclick = () => xrTool('move'); $('#x-shade').onclick = () => xrTool('shade'); $('#x-erase').onclick = () => xrTool('erase');
$('#x-brush').oninput = (e) => { xr.brush = +e.target.value; };
$('#x-sens').oninput = (e) => { xr.sens = +e.target.value; if (xr.img && xr.auto) { clearTimeout(xr.timer); xr.timer = setTimeout(() => xrFind(false), 150); } };
$('#x-find').onclick = () => xrFind(true);
$('#x-undo').onclick = () => { if (!xr.img || !xr.undo.length) return; xr.mask = xr.undo.pop(); xr.auto = false; xrRedrawMask(); xrRender(); xrClassify(); };
$('#x-clear').onclick = () => {
  if (!xr.img) return;
  xr.undo.push(xr.mask.slice()); xr.mask = new Uint8Array(xr.iw * xr.ih); xr.auto = false;
  xrRedrawMask(); xrRender(); xrClassify(); $('#x-marknote').textContent = 'Cleared. Shade the decay, or press Find dark areas.';
};
function xrStamp(tx, ty, val) {
  const M = xrM(), Mi = xrInv(M), ix = Mi[0] * tx + Mi[1] * ty + Mi[2], iy = Mi[3] * tx + Mi[4] * ty + Mi[5];
  const r = xr.brush / Math.sqrt(Math.abs(M[0] * M[4] - M[1] * M[3])), { iw, ih, mask } = xr;
  const x0 = Math.max(0, Math.floor(ix - r)), x1 = Math.min(iw - 1, Math.ceil(ix + r)), y0 = Math.max(0, Math.floor(iy - r)), y1 = Math.min(ih - 1, Math.ceil(iy + r));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if ((x - ix) ** 2 + (y - iy) ** 2 <= r * r) mask[y * iw + x] = val;
  const g = xr.maskG;
  g.save(); g.globalCompositeOperation = val ? 'source-over' : 'destination-out'; g.fillStyle = '#ff3b30';
  g.beginPath(); g.arc(ix, iy, r, 0, 7); g.fill(); g.restore();
}

// pointer gestures: one finger moves or paints, two fingers pinch, turn and move
const xp = new Map();
let xg = null;
function xrGestureStart() {
  const pts = [...xp.values()];
  xg = { p0: Object.assign({}, xr.p), pts: pts.map(p => p.slice()), paint: false };
}
function xrDown(e) {
  if (!xr.img) return;
  e.preventDefault(); stack.setPointerCapture(e.pointerId);
  xp.set(e.pointerId, toCanon(e));
  if (xp.size > 2) return;
  if (xr.tool === 'move' || xp.size === 2) { xrGestureStart(); stack.classList.add('grabbing'); return; }
  xr.undo.push(xr.mask.slice()); if (xr.undo.length > 20) xr.undo.shift();
  xr.auto = false;
  const p = xp.get(e.pointerId);
  xg = { paint: true, last: p.slice() };
  xrStamp(p[0], p[1], xr.tool === 'shade' ? 1 : 0); xrRender();
}
function xrMove(e) {
  if (!xp.has(e.pointerId) || !xg) return;
  const p = toCanon(e);
  xp.set(e.pointerId, p);
  if (xg.paint) {
    const [lx, ly] = xg.last, d = Math.hypot(p[0] - lx, p[1] - ly), n = Math.max(1, Math.ceil(d / (xr.brush * .4)));
    for (let k = 1; k <= n; k++) xrStamp(lx + (p[0] - lx) * k / n, ly + (p[1] - ly) * k / n, xr.tool === 'shade' ? 1 : 0);
    xg.last = p; xrRender();
    clearTimeout(xr.timer); xr.timer = setTimeout(xrClassify, 120);
    return;
  }
  const pts = [...xp.values()], p0 = xg.p0;
  if (pts.length === 1 || xg.pts.length === 1) {
    const a = xg.pts[0], b = pts[0];
    xr.p = Object.assign({}, p0, { cx: p0.cx + b[0] - a[0], cy: p0.cy + b[1] - a[1] });
  } else {
    const [a0, a1] = xg.pts, [b0, b1] = pts;
    const m0 = [(a0[0] + a1[0]) / 2, (a0[1] + a1[1]) / 2], m1 = [(b0[0] + b1[0]) / 2, (b0[1] + b1[1]) / 2];
    const v0 = [a1[0] - a0[0], a1[1] - a0[1]], v1 = [b1[0] - b0[0], b1[1] - b0[1]];
    const f = Math.min(8, Math.max(1 / 8, Math.hypot(v1[0], v1[1]) / Math.max(Math.hypot(v0[0], v0[1]), 1)));
    const dt = Math.atan2(v1[1], v1[0]) - Math.atan2(v0[1], v0[0]), co = Math.cos(dt), si = Math.sin(dt);
    const rx = p0.cx - m0[0], ry = p0.cy - m0[1];
    xr.p = Object.assign({}, p0, { cx: m1[0] + f * (co * rx - si * ry), cy: m1[1] + f * (si * rx + co * ry), s: p0.s * f, rot: p0.rot + dt });
  }
  xrChanged();
}
function xrUp(e) {
  if (!xp.has(e.pointerId)) return;
  xp.delete(e.pointerId);
  stack.classList.remove('grabbing');
  if (xg && xg.paint) { xg = null; xrClassify(); return; }
  if (xp.size && xg) xrGestureStart(); else xg = null;
}
stack.addEventListener('wheel', (e) => {
  if (st.mode !== 'xray' || !xr.img) return;
  e.preventDefault();
  const [px, py] = toCanon(e), f = Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.004);
  const s = Math.min(xr.s0 * 16, Math.max(xr.s0 / 8, xr.p.s * f)), g = s / xr.p.s;
  xr.p.cx = px + g * (xr.p.cx - px); xr.p.cy = py + g * (xr.p.cy - py); xr.p.s = s;
  xrChanged();
}, { passive: false });
stack.addEventListener('keydown', (e) => {
  if (st.mode !== 'xray' || !xr.img) return;
  const step = e.shiftKey ? 10 : 2, p = xr.p;
  const act = { ArrowLeft: () => { p.cx -= step; }, ArrowRight: () => { p.cx += step; }, ArrowUp: () => { p.cy -= step; }, ArrowDown: () => { p.cy += step; },
    '+': () => { p.s *= 1.03; }, '=': () => { p.s *= 1.03; }, '-': () => { p.s /= 1.03; }, '[': () => { p.rot -= Math.PI / 180; }, ']': () => { p.rot += Math.PI / 180; } }[e.key];
  if (!act) return;
  e.preventDefault(); act(); xrChanged();
});
