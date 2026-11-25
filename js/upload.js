/* Getting an image in: camera, file picker, drag and drop, paste, "share to" from the phone's gallery
 * (when installed as an app), and the examples. Works out what kind of image it is and sends it to the
 * right view. Also the image editor (crop, turn, invert, contrast) and sharing a result. */

const EXAMPLES = [
  ['opg', 'Panoramic', 'panoramic'], ['bitewing', 'Bite-wing', 'bitewing'],
  ['xray-dentin', 'Molar · dentin', 'periapical'], ['xray-enamel', 'Molar · enamel', 'periapical'],
  ['xray-pulp', 'Molar · pulp', 'periapical'], ['xray-sound', 'Molar · sound', 'periapical'],
  ['premolar-dentin', 'Premolar', 'periapical'], ['incisor-dentin', 'Front tooth', 'periapical'],
];
const TYPENAME = { panoramic: 'panoramic X-ray', bitewing: 'bite-wing X-ray', periapical: 'single-tooth X-ray', photo: 'photo of a tooth', diagram: 'diagram photo' };
const up = { src: null, label: '', type: 'auto' }; // the last image added, before any view changed it

// ------------------------------------------------------------ decode, measure, route
async function toBitmap(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) { return await createImageBitmap(blob); }
}
function canvasOf(src, maxSide) {
  const s = Math.min(1, (maxSide || 3200) / Math.max(src.width, src.height)), c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * s)); c.height = Math.max(1, Math.round(src.height * s));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}
// colour, brightness and a grey copy (about 600 px wide) to decide what the image is
function measure(c) {
  const s = Math.min(1, 600 / Math.max(c.width, c.height)), w = Math.max(8, Math.round(c.width * s)), h = Math.max(8, Math.round(c.height * s));
  const t = document.createElement('canvas'); t.width = w; t.height = h;
  const g = t.getContext('2d', { willReadFrequently: true }); g.drawImage(c, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, grey = new Float32Array(w * h);
  let sum = 0, dark = 0, sat = 0;
  for (let i = 0; i < w * h; i++) {
    const R = d[4 * i], G = d[4 * i + 1], B = d[4 * i + 2], v = 0.299 * R + 0.587 * G + 0.114 * B, mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    grey[i] = v; sum += v; if (v < 80) dark++; sat += mx > 30 ? (mx - mn) / mx : 0;
  }
  return { grey, w, h, rgb: { mean: sum / (w * h), dark: dark / (w * h), sat: sat / (w * h) } };
}
// Add an image from any source. type: 'auto' or a forced type.
async function openImage(blobOrCanvas, label, type) {
  setBusy(true, 'Opening the image…');
  let c;
  try {
    const src = blobOrCanvas instanceof Blob ? await toBitmap(blobOrCanvas) : blobOrCanvas;
    c = canvasOf(src);
  } catch (e) {
    setBusy(false);
    $('#typenote').textContent = 'That file could not be opened as an image. Try a JPEG or PNG.';
    goWork();
    return;
  }
  setBusy(false);
  up.src = c; up.label = label; up.type = type || $('#x-type').value || 'auto';
  await routeImage(c, label, up.type);
}
async function routeImage(c, label, type) {
  let kind = type, why = '';
  if (!kind || kind === 'auto') {
    const m = measure(c), r = DentalScan.classify(m.grey, m.w, m.h, m.rgb);
    kind = r.type; why = r.why;
  }
  $('#typenote').textContent = kind === 'diagram' ? '' : `Read as a ${TYPENAME[kind]}${why ? ': ' + why.charAt(0).toLowerCase() + why.slice(1) : '.'} Wrong? Change the image type.`;
  if (kind !== 'diagram') $('#x-type').value = type === 'auto' || !type ? 'auto' : kind;
  goWork();
  if (kind === 'diagram') {
    if (st.mode !== 'photo') setMode('photo');
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
    await analyseBlob(blob, label);
    $('#share').hidden = false;
  } else if (kind === 'panoramic' || kind === 'bitewing') {
    await wvLoad(c, label, kind);
  } else {
    wv.img = null; // a single tooth: forget any whole image
    await xrOpen(c, label, { route: false, tplOnly: null, kind: kind === 'photo' ? 'photo' : 'xray' });
  }
}
$('#x-type').onchange = () => { if (up.src) routeImage(up.src, up.label, $('#x-type').value); };

// ------------------------------------------------------------ the ways in
function onPick(e) {
  const f = e.target.files && e.target.files[0];
  if (f) { document.querySelectorAll('.thumb').forEach(t => t.setAttribute('aria-current', 'false')); openImage(f, f.name ? 'Your image · ' + f.name : 'Your image'); }
  e.target.value = '';
}
$('#u-cam').onchange = onPick; $('#u-pick').onchange = onPick;
// drag and drop anywhere on the page
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
document.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#dropveil').hidden = false; });
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropveil').hidden = true; });
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('#dropveil').hidden = true;
  const f = [...e.dataTransfer.files].find(x => /^image\//.test(x.type));
  if (f) openImage(f, 'Dropped image · ' + f.name);
  else $('#typenote').textContent = 'That was not an image file.';
});
// paste an image (a screenshot, an image copied from a viewer)
document.addEventListener('paste', (e) => {
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  const items = [...((e.clipboardData && e.clipboardData.items) || [])], it = items.find(x => x.kind === 'file' && /^image\//.test(x.type));
  if (!it) return;
  e.preventDefault();
  openImage(it.getAsFile(), 'Pasted image');
});
// shared from another app (Android, installed app): the service worker keeps the file for us
async function takeShared() {
  if (!/[?&]shared=1/.test(location.search) || !('caches' in window)) return false;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('caries-share'), res = await cache.match('shared-image');
    if (!res) return false;
    const blob = await res.blob();
    await cache.delete('shared-image');
    await openImage(blob, 'Shared image');
    return true;
  } catch (e) { return false; }
}
// examples
$('#xthumbs').innerHTML = EXAMPLES.map(([id, name]) => `<button class="thumb xthumb" data-id="${id}" aria-current="false"><img src="samples/${id}-thumb.jpg" alt="" loading="lazy"><b>${name}</b></button>`).join('');
$('#xthumbs').onclick = async (e) => {
  const b = e.target.closest('.thumb');
  if (!b) return;
  const ex = EXAMPLES.find(x => x[0] === b.dataset.id);
  document.querySelectorAll('.thumb').forEach(t => t.setAttribute('aria-current', String(t === b)));
  try {
    const resp = await fetch(`samples/${ex[0]}.jpg`);
    if (!resp.ok) throw new Error(resp.status);
    await openImage(await resp.blob(), `Example (simulated) · ${ex[1].toLowerCase()}`, 'auto');
  } catch (err) { $('#typenote').textContent = 'The example could not be loaded here.'; goWork(); }
};

// ------------------------------------------------------------ image editor: crop, turn, mirror, invert, contrast
const ed = { src: null, rot: 0, flip: false, invert: false, enhance: false, crop: null, drag: null };
const edc = $('#ed-canvas'), edg = edc.getContext('2d');
function edRender() { // the edited image, without the crop
  const r = ed.rot % 2 !== 0, w = r ? ed.src.height : ed.src.width, h = r ? ed.src.width : ed.src.height;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.translate(w / 2, h / 2); g.rotate(ed.rot * Math.PI / 2); if (ed.flip) g.scale(-1, 1);
  g.drawImage(ed.src, -ed.src.width / 2, -ed.src.height / 2);
  if (ed.invert || ed.enhance) {
    const id = g.getImageData(0, 0, w, h), d = id.data;
    let lo = 0, hi = 255;
    if (ed.enhance) { // stretch the 1st to 99th percentile to the full range
      const hist = new Uint32Array(256);
      for (let i = 0; i < d.length; i += 4) hist[(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0]++;
      const n = d.length / 4; let acc = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.01) { lo = v; break; } }
      acc = 0; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.01) { hi = v; break; } }
      if (hi - lo < 10) { lo = 0; hi = 255; }
    }
    const k = 255 / (hi - lo);
    for (let i = 0; i < d.length; i += 4) for (let j = 0; j < 3; j++) {
      let v = (d[i + j] - lo) * k; v = v < 0 ? 0 : v > 255 ? 255 : v;
      d[i + j] = ed.invert ? 255 - v : v;
    }
    g.setTransform(1, 0, 0, 1, 0, 0); g.putImageData(id, 0, 0);
  }
  return c;
}
let edImg = null, edFit = null;
function edDraw() {
  const r = edc.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  edc.width = Math.max(1, Math.round(r.width * dpr)); edc.height = Math.max(1, Math.round(r.height * dpr));
  const s = Math.min(r.width / edImg.width, r.height / edImg.height), ox = (r.width - edImg.width * s) / 2, oy = (r.height - edImg.height * s) / 2;
  edFit = { s, ox, oy };
  edg.setTransform(dpr, 0, 0, dpr, 0, 0);
  edg.fillStyle = '#060b10'; edg.fillRect(0, 0, r.width, r.height);
  edg.drawImage(edImg, ox, oy, edImg.width * s, edImg.height * s);
  if (ed.crop) {
    const [x0, y0, x1, y1] = ed.crop.map((v, i) => i % 2 ? oy + v * s : ox + v * s);
    edg.fillStyle = 'rgba(0,0,0,.55)'; edg.beginPath(); edg.rect(ox, oy, edImg.width * s, edImg.height * s); edg.rect(x0, y0, x1 - x0, y1 - y0); edg.fill('evenodd');
    edg.strokeStyle = '#fff'; edg.lineWidth = 2; edg.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }
}
function edUpdate() {
  edImg = edRender(); ed.crop = null; edDraw();
  $('#ed-invert').setAttribute('aria-pressed', String(ed.invert)); $('#ed-enhance').setAttribute('aria-pressed', String(ed.enhance));
}
const edPt = (e) => { const r = edc.getBoundingClientRect(); return [(e.clientX - r.left - edFit.ox) / edFit.s, (e.clientY - r.top - edFit.oy) / edFit.s]; };
edc.addEventListener('pointerdown', (e) => { e.preventDefault(); edc.setPointerCapture(e.pointerId); ed.drag = edPt(e); });
edc.addEventListener('pointermove', (e) => {
  if (!ed.drag) return;
  const [ax, ay] = ed.drag, [bx, by] = edPt(e), cl = (v, m) => Math.max(0, Math.min(m, v));
  ed.crop = [cl(Math.min(ax, bx), edImg.width), cl(Math.min(ay, by), edImg.height), cl(Math.max(ax, bx), edImg.width), cl(Math.max(ay, by), edImg.height)];
  edDraw();
});
const edEnd = () => { ed.drag = null; if (ed.crop && (ed.crop[2] - ed.crop[0] < 20 || ed.crop[3] - ed.crop[1] < 20)) { ed.crop = null; edDraw(); } };
edc.addEventListener('pointerup', edEnd); edc.addEventListener('pointercancel', edEnd);
$('#ed-left').onclick = () => { ed.rot = (ed.rot + 3) % 4; edUpdate(); };
$('#ed-right').onclick = () => { ed.rot = (ed.rot + 1) % 4; edUpdate(); };
$('#ed-flip').onclick = () => { ed.flip = !ed.flip; edUpdate(); };
$('#ed-invert').onclick = () => { ed.invert = !ed.invert; edUpdate(); };
$('#ed-enhance').onclick = () => { ed.enhance = !ed.enhance; edUpdate(); };
$('#ed-reset').onclick = () => { Object.assign(ed, { rot: 0, flip: false, invert: false, enhance: false, crop: null }); edUpdate(); };
function openEditor() {
  if (!up.src) { $('#a-note').textContent = 'Add an image first.'; return; }
  Object.assign(ed, { src: up.src, rot: 0, flip: false, invert: false, enhance: false, crop: null, drag: null });
  $('#ed-type').value = up.type && up.type !== 'auto' ? up.type : 'auto';
  $('#editor').showModal();
  requestAnimationFrame(edUpdate);
}
$('#a-open').onclick = openEditor;
$('#editor').addEventListener('close', async () => {
  if ($('#editor').returnValue !== 'done' || !edImg) return;
  let out = edImg;
  if (ed.crop) {
    const [x0, y0, x1, y1] = ed.crop.map(Math.round), c = document.createElement('canvas');
    c.width = x1 - x0; c.height = y1 - y0; c.getContext('2d').drawImage(edImg, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
    out = c;
  }
  const t = $('#ed-type').value;
  up.src = out; up.type = t; up.label = up.label.replace(/ · adjusted$/, '') + ' · adjusted';
  await routeImage(out, up.label, t);
});
window.addEventListener('resize', () => { if ($('#editor').open && edImg) edDraw(); });

// ------------------------------------------------------------ share or save the result
async function resultImage() {
  const pad = 28, lines = [];
  let pic;
  if (st.mode === 'xray' && st.xview === 'whole' && wv.img) {
    pic = wc;
    lines.push(($('#w-title').textContent || 'X-ray'), $('#w-lead').textContent);
    for (const t of wv.teeth.values()) lines.push(`${t.fdi ? 'Tooth ' + t.fdi : (t.upper ? 'Upper' : 'Lower') + ' tooth'}: ${t.pred ? CLS[t.pred].name : 'not read'}${t.code ? ' (' + t.code + ')' : ''}`);
  } else {
    const c = document.createElement('canvas'); c.width = W * K; c.height = H * K;
    const g = c.getContext('2d');
    for (const id of ['c-base', 'c-tint', 'c-line', 'c-paint', 'c-les']) { const el = $('#' + id); if (el.style.display !== 'none') g.drawImage(el, 0, 0); }
    pic = c;
    lines.push($('#cls').textContent + ($('#bandline').textContent ? ' · ' + $('#bandline').textContent : ''), $('#why').textContent);
    for (const li of document.querySelectorAll('#findings li b')) lines.push('• ' + li.textContent);
  }
  const wPic = Math.min(1200, pic.width), hPic = Math.round(pic.height * wPic / pic.width), lh = 30;
  const out = document.createElement('canvas'); out.width = wPic + 2 * pad;
  out.height = hPic + 2 * pad + (lines.filter(Boolean).length + 2) * lh;
  const g = out.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, out.width, out.height);
  g.drawImage(pic, pad, pad, wPic, hPic);
  g.fillStyle = '#121519'; g.font = '600 22px "Instrument Sans", system-ui, sans-serif';
  let y = hPic + pad + 36;
  lines.filter(Boolean).forEach((t, i) => { g.font = (i ? '400 19px' : '700 23px') + ' "Instrument Sans", system-ui, sans-serif'; g.fillText(t.slice(0, 110), pad, y); y += lh; });
  g.fillStyle = '#59626c'; g.font = '400 16px "Instrument Sans", system-ui, sans-serif';
  g.fillText('Caries Depth Checker · a teaching aid, not a diagnosis.', pad, y + 6);
  return { canvas: out, text: lines.filter(Boolean).join('\n') };
}
$('#share').onclick = async () => {
  const { canvas, text } = await resultImage();
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  const file = new File([blob], 'caries-check.png', { type: 'image/png' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Caries check', text }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = 'caries-check.png'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};

// ------------------------------------------------------------ bridge for the AI review (a module script)
window.CDC = {
  // the image on screen, as a JPEG data string no larger than about 1568 px, and what it shows
  aiImage() {
    let c = null, what = '';
    if (st.mode === 'xray' && st.xview === 'whole' && wv.img) { c = wv.img; what = TYPENAME[wv.type]; }
    else if (st.mode === 'xray' && xr.img) { c = xr.img; what = xr.ctx ? 'one tooth cropped from a ' + TYPENAME[xr.ctx.type] + (xr.ctx.upper ? ' (an upper tooth, turned crown-up)' : '') : TYPENAME[up.type !== 'auto' ? up.type : 'periapical']; }
    else if (st.mode === 'photo' && up.src) { c = up.src; what = 'photo of a shaded diagram of a molar'; }
    if (!c) return null;
    const out = canvasOf(c, 1568);
    return { data: out.toDataURL('image/jpeg', 0.9).split(',')[1], w: out.width, h: out.height, what, view: st.mode === 'xray' ? st.xview : st.mode };
  },
  // show the boxes the AI drew on the image on screen
  aiShow(findings) {
    if (st.mode === 'xray' && st.xview === 'whole' && wv.img) { wv.ai = findings; wvDraw(); }
    else if (st.mode === 'xray' && xr.img) { xr.ai = findings; xrRender(); }
  },
  takeShared,
};
