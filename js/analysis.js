/* Diagram-photo pipeline shared by the page and the worker: analyse, then build the views the page draws. */
function runAnalysis(E, w, h, px) {
  const n = w * h, c = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) { c[0][i] = px[4 * i]; c[1][i] = px[4 * i + 1]; c[2][i] = px[4 * i + 2]; }
  const t0 = Date.now(), r = E.analyseImage({ w, h, c }), ms = Date.now() - t0;
  if (!r.ok) return { res: { ok: false, error: r.error, ms } };
  const T = E.T, N = T.W * T.H, wc = E.warpColour(r.crop, r.M), view = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) { view[4 * i] = wc[0][i]; view[4 * i + 1] = wc[1][i]; view[4 * i + 2] = wc[2][i]; view[4 * i + 3] = 255; }
  const cw = r.crop.w, ch = r.crop.h, s = Math.min(1, 360 / Math.max(cw, ch)), tw = Math.max(1, Math.round(cw * s)), th = Math.max(1, Math.round(ch * s));
  const thumb = new Uint8ClampedArray(tw * th * 4), sil = r.sil, st = Math.max(1, Math.round(1.5 / s));
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const sx = Math.min(cw - 1, Math.floor(x / s)), sy = Math.min(ch - 1, Math.floor(y / s)), j = sy * cw + sx, o = 4 * (y * tw + x);
    let edge = false;
    if (sil[j]) for (const [dx, dy] of [[st, 0], [-st, 0], [0, st], [0, -st]]) {
      const xx = sx + dx, yy = sy + dy;
      if (xx < 0 || yy < 0 || xx >= cw || yy >= ch || !sil[yy * cw + xx]) { edge = true; break; }
    }
    if (edge) { thumb[o] = 40; thumb[o + 1] = 120; thumb[o + 2] = 230; }
    else { thumb[o] = r.crop.c[0][j]; thumb[o + 1] = r.crop.c[1][j]; thumb[o + 2] = r.crop.c[2][j]; }
    thumb[o + 3] = 255;
  }
  const res = { ok: true, ms, pred: r.pred, depth: r.depth, contact: r.contact, area: r.area, a_en: r.a_en, a_de: r.a_de, a_pu: r.a_pu, deep: r.deep, quality: r.quality, lowQuality: r.lowQuality };
  return { res, view, core: r.maps.core, grown: r.maps.grown, thumb, tw, th };
}
