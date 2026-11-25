/* Caries depth engine: in-browser port of the Python reference (scripts/engine.py).
 *
 * Pipeline: ink map -> find tooth outline -> register to the reference diagram (moments,
 * silhouette ICP, outline ICP, projective refinement) -> isolate shading -> measure how deep it
 * reaches on the S scale (0 surface, 1 enamel-dentin junction, 2 pulp) -> classify.
 * Everything runs locally; no image leaves the device.
 */
(function (root) {
  'use strict';

  const P = {
    WORK_LONG: 1024, BG_K: 31, INK_T: 0.38, LESION_T: 0.45, LINE_EXCL: 5, OPEN_K: 5,
    MIN_COMP: 50, MIN_THICK: 3.0, N_DEEP: 30, A_MIN: 200, T_DENTIN: 1.29, REACH: 10, C_MIN: 25,
    MIN_QUALITY: 0.5, INK_T_COARSE: 0.25, INK_T_LOW: 0.12, TOOTH_H: 600, LINE_INK: 0.75,
    TPL_ELONG: 1.573, TPL_FILL: 0.776, TPL_DENSITY: 0.218,
  };
  const Z = { OUT: 0, EN: 1, DE: 2, PU: 3, LINE: 4 };
  const INF = 1e20;

  // ------------------------------------------------------------------ small linear algebra
  const I3 = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];
  function mul3(a, b) {
    const r = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    return r;
  }
  function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    const s = 1 / det;
    return [A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
      B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
      C * s, -(a * h - b * g) * s, (a * e - b * d) * s];
  }
  function applyH(M, x, y) {
    const w = M[6] * x + M[7] * y + M[8];
    return [(M[0] * x + M[1] * y + M[2]) / w, (M[3] * x + M[4] * y + M[5]) / w];
  }
  function solve(A, b, n) { // Gaussian elimination with partial pivoting; A is n*n row-major
    const M = A.slice(), v = b.slice();
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
      if (Math.abs(M[p * n + c]) < 1e-12) return null;
      if (p !== c) {
        for (let k = 0; k < n; k++) { const t = M[c * n + k]; M[c * n + k] = M[p * n + k]; M[p * n + k] = t; }
        const t = v[c]; v[c] = v[p]; v[p] = t;
      }
      for (let r = c + 1; r < n; r++) {
        const f = M[r * n + c] / M[c * n + c];
        if (f === 0) continue;
        for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
        v[r] -= f * v[c];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = v[r];
      for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
      x[r] = s / M[r * n + r];
    }
    return x;
  }
  function svd2(a, b, c, d) {
    const S = a * a + b * b + c * c + d * d, D = a * d - b * c;
    const disc = Math.sqrt(Math.max(0, S * S - 4 * D * D));
    return [Math.sqrt((S + disc) / 2), Math.sqrt(Math.max(0, (S - disc) / 2))];
  }

  // point sets are {x: Float64Array, y: Float64Array, n}
  function fitSimilarity(sx, sy, dx, dy, n) {
    let msx = 0, msy = 0, mdx = 0, mdy = 0;
    for (let i = 0; i < n; i++) { msx += sx[i]; msy += sy[i]; mdx += dx[i]; mdy += dy[i]; }
    msx /= n; msy /= n; mdx /= n; mdy /= n;
    let sxx = 0, c = 0, s = 0;
    for (let i = 0; i < n; i++) {
      const ax = sx[i] - msx, ay = sy[i] - msy, bx = dx[i] - mdx, by = dy[i] - mdy;
      sxx += ax * ax + ay * ay; c += ax * bx + ay * by; s += ax * by - ay * bx;
    }
    sxx = Math.max(sxx, 1e-9); c /= sxx; s /= sxx;
    return [c, -s, mdx - (c * msx - s * msy), s, c, mdy - (s * msx + c * msy), 0, 0, 1];
  }
  function fitAffine(sx, sy, dx, dy, n) {
    const A = new Array(9).fill(0), bx = [0, 0, 0], by = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const r = [sx[i], sy[i], 1];
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) A[a * 3 + b] += r[a] * r[b];
        bx[a] += r[a] * dx[i]; by[a] += r[a] * dy[i];
      }
    }
    const px = solve(A, bx, 3), py = solve(A, by, 3);
    if (!px || !py) return null;
    return [px[0], px[1], px[2], py[0], py[1], py[2], 0, 0, 1];
  }
  function normT(x, y, n) {
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += x[i]; cy += y[i]; }
    cx /= n; cy /= n;
    let md = 0;
    for (let i = 0; i < n; i++) md += Math.hypot(x[i] - cx, y[i] - cy);
    md /= n;
    const s = Math.SQRT2 / Math.max(md, 1e-9);
    return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
  }
  function fitHomography(sx, sy, dx, dy, n) {
    const Ts = normT(sx, sy, n), Td = normT(dx, dy, n);
    const A = new Array(64).fill(0), b = new Array(8).fill(0);
    const r1 = new Array(8), r2 = new Array(8);
    for (let i = 0; i < n; i++) {
      const s0 = Ts[0] * sx[i] + Ts[2], s1 = Ts[4] * sy[i] + Ts[5];
      const d0 = Td[0] * dx[i] + Td[2], d1 = Td[4] * dy[i] + Td[5];
      r1[0] = s0; r1[1] = s1; r1[2] = 1; r1[3] = 0; r1[4] = 0; r1[5] = 0; r1[6] = -s0 * d0; r1[7] = -s1 * d0;
      r2[0] = 0; r2[1] = 0; r2[2] = 0; r2[3] = s0; r2[4] = s1; r2[5] = 1; r2[6] = -s0 * d1; r2[7] = -s1 * d1;
      for (let a = 0; a < 8; a++) {
        const ra = r1[a], qa = r2[a];
        for (let c = 0; c < 8; c++) A[a * 8 + c] += ra * r1[c] + qa * r2[c];
        b[a] += ra * d0 + qa * d1;
      }
    }
    const h = solve(A, b, 8);
    if (!h) return null;
    const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
    return mul3(inv3(Td), mul3(Hn, Ts));
  }

  // ------------------------------------------------------------------ image helpers
  function reflect101(i, n) {
    if (n === 1) return 0;
    const period = 2 * (n - 1);
    i = Math.abs(i) % period;
    return i < n ? i : period - i;
  }
  // INTER_AREA style downscale (separable box weights)
  function areaWeights(sn, dn) {
    const scale = sn / dn, tab = [];
    for (let d = 0; d < dn; d++) {
      const a = d * scale, b = (d + 1) * scale, list = [];
      for (let s = Math.floor(a); s < Math.min(sn, Math.ceil(b)); s++) {
        const w = Math.min(b, s + 1) - Math.max(a, s);
        if (w > 1e-9) list.push(s, w / scale);
      }
      tab.push(list);
    }
    return tab;
  }
  function resizeArea(src, sw, sh, dw, dh) {
    const wx = areaWeights(sw, dw), wy = areaWeights(sh, dh);
    const tmp = new Float32Array(dw * sh), out = new Float32Array(dw * dh);
    for (let y = 0; y < sh; y++) {
      const ro = y * sw, to = y * dw;
      for (let x = 0; x < dw; x++) {
        const l = wx[x]; let s = 0;
        for (let k = 0; k < l.length; k += 2) s += src[ro + l[k]] * l[k + 1];
        tmp[to + x] = s;
      }
    }
    for (let y = 0; y < dh; y++) {
      const l = wy[y], oo = y * dw;
      for (let x = 0; x < dw; x++) {
        let s = 0;
        for (let k = 0; k < l.length; k += 2) s += tmp[l[k] * dw + x] * l[k + 1];
        out[oo + x] = s;
      }
    }
    return out;
  }
  function linearTab(sn, dn) {
    const scale = sn / dn, i0 = new Int32Array(dn), fr = new Float32Array(dn);
    for (let d = 0; d < dn; d++) {
      let f = (d + 0.5) * scale - 0.5, s = Math.floor(f);
      f -= s;
      if (s < 0) { f = 0; s = 0; }
      if (s >= sn - 1) { f = 0; s = sn - 1; }
      i0[d] = s; fr[d] = f;
    }
    return [i0, fr];
  }
  function resizeLinear(src, sw, sh, dw, dh) {
    const [x0, fx] = linearTab(sw, dw), [y0, fy] = linearTab(sh, dh);
    const out = new Float32Array(dw * dh);
    for (let y = 0; y < dh; y++) {
      const ya = y0[y], yb = Math.min(ya + 1, sh - 1), b = fy[y];
      for (let x = 0; x < dw; x++) {
        const xa = x0[x], xb = Math.min(xa + 1, sw - 1), a = fx[x];
        const p = src[ya * sw + xa] * (1 - a) + src[ya * sw + xb] * a;
        const q = src[yb * sw + xa] * (1 - a) + src[yb * sw + xb] * a;
        out[y * dw + x] = p * (1 - b) + q * b;
      }
    }
    return out;
  }
  function resizePlanes(img, dw, dh, area) {
    const f = area ? resizeArea : resizeLinear;
    return { w: dw, h: dh, c: img.c.map(p => f(p, img.w, img.h, dw, dh)) };
  }
  // separable max/min filter, square k (odd), out-of-bounds ignored (OpenCV morphology default)
  function rankFilter(src, w, h, k, isMax) {
    const r = k >> 1, tmp = new (src.constructor)(w * h), out = new (src.constructor)(w * h);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        let v = src[o + x];
        const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
        if (isMax) { for (let i = a; i <= b; i++) if (src[o + i] > v) v = src[o + i]; }
        else { for (let i = a; i <= b; i++) if (src[o + i] < v) v = src[o + i]; }
        tmp[o + x] = v;
      }
    }
    for (let y = 0; y < h; y++) {
      const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        let v = tmp[y * w + x];
        if (isMax) { for (let i = a; i <= b; i++) { const t = tmp[i * w + x]; if (t > v) v = t; } }
        else { for (let i = a; i <= b; i++) { const t = tmp[i * w + x]; if (t < v) v = t; } }
        out[y * w + x] = v;
      }
    }
    return out;
  }
  const dilate = (m, w, h, k) => rankFilter(m, w, h, k, true);
  const erode = (m, w, h, k) => rankFilter(m, w, h, k, false);
  const opening = (m, w, h, k) => dilate(erode(m, w, h, k), w, h, k);
  const closing = (m, w, h, k) => erode(dilate(m, w, h, k), w, h, k);
  function boxBlur(src, w, h, k) {
    const r = k >> 1, tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += src[y * w + reflect101(x + i, w)];
      tmp[y * w + x] = s / k;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += tmp[reflect101(y + i, h) * w + x];
      out[y * w + x] = s / k;
    }
    return out;
  }

  // ink map: per-channel background normalisation, 0 = paper, 1 = black
  function inkMap(img) {
    const { w, h } = img;
    const sw = Math.max(1, Math.floor(w / 8)), sh = Math.max(1, Math.floor(h / 8));
    const ink = new Float32Array(w * h);
    for (const ch of img.c) {
      let bg = resizeArea(ch, w, h, sw, sh);
      bg = erode(dilate(bg, sw, sh, P.BG_K), sw, sh, P.BG_K);
      bg = boxBlur(bg, sw, sh, P.BG_K);
      bg = resizeLinear(bg, sw, sh, w, h);
      for (let i = 0; i < w * h; i++) {
        let n = ch[i] / Math.max(bg[i], 8);
        if (n > 1) n = 1; else if (n < 0) n = 0;
        const v = 1 - n;
        if (v > ink[i]) ink[i] = v;
      }
    }
    return ink;
  }

  // connected components, union-find; returns {lab, n, area, x0, y0, x1, y1}
  function components(mask, w, h, conn8) {
    const lab = new Int32Array(w * h);
    let parent = new Int32Array(1024), next = 1;
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const unite = (a, b) => { a = find(a); b = find(b); if (a < b) parent[b] = a; else if (b < a) parent[a] = b; return a < b ? a : b; };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let l = 0;
      if (x > 0 && mask[i - 1]) l = lab[i - 1];
      if (y > 0) {
        if (mask[i - w]) l = l ? unite(l, lab[i - w]) : lab[i - w];
        if (conn8) {
          if (x > 0 && mask[i - w - 1]) l = l ? unite(l, lab[i - w - 1]) : lab[i - w - 1];
          if (x < w - 1 && mask[i - w + 1]) l = l ? unite(l, lab[i - w + 1]) : lab[i - w + 1];
        }
      }
      if (!l) {
        if (next >= parent.length) { const np = new Int32Array(parent.length * 2); np.set(parent); parent = np; }
        l = next; parent[next] = next; next++;
      }
      lab[i] = l;
    }
    const remap = new Int32Array(next);
    let n = 0;
    for (let l = 1; l < next; l++) { const r = find(l); if (!remap[r]) remap[r] = ++n; remap[l] = remap[r]; }
    const area = new Int32Array(n + 1), x0 = new Int32Array(n + 1).fill(w), y0 = new Int32Array(n + 1).fill(h),
      x1 = new Int32Array(n + 1).fill(-1), y1 = new Int32Array(n + 1).fill(-1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!lab[i]) continue;
      const l = remap[lab[i]];
      lab[i] = l; area[l]++;
      if (x < x0[l]) x0[l] = x;
      if (x > x1[l]) x1[l] = x;
      if (y < y0[l]) y0[l] = y;
      if (y > y1[l]) y1[l] = y;
    }
    return { lab, n, area, x0, y0, x1, y1 };
  }

  // fill a closed outline: everything not 4-reachable from the border through non-line pixels
  function fillOutline(lines, w, h) {
    const W = w + 2, H = h + 2, seen = new Uint8Array(W * H), stack = new Int32Array(W * H);
    const blocked = (X, Y) => X > 0 && Y > 0 && X < W - 1 && Y < H - 1 && lines[(Y - 1) * w + (X - 1)];
    let sp = 0;
    stack[sp++] = 0; seen[0] = 1;
    const push = (X, Y) => {
      if (X < 0 || Y < 0 || X >= W || Y >= H) return;
      const j = Y * W + X;
      if (seen[j] || blocked(X, Y)) return;
      seen[j] = 1; stack[sp++] = j;
    };
    while (sp) {
      const i = stack[--sp], X = i % W, Y = (i - X) / W;
      push(X - 1, Y); push(X + 1, Y); push(X, Y - 1); push(X, Y + 1);
    }
    const sil = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sil[y * w + x] = seen[(y + 1) * W + (x + 1)] ? 0 : 1;
    return sil;
  }

  function hysteresis(ink, w, h, hi, lo) {
    const weak = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) weak[i] = ink[i] > lo ? 1 : 0;
    const cc = components(weak, w, h, true);
    const strong = new Uint8Array(cc.n + 1);
    for (let i = 0; i < w * h; i++) if (ink[i] > hi) strong[cc.lab[i]] = 1;
    strong[0] = 0;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = strong[cc.lab[i]];
    return out;
  }

  function moments(mask, w, h) {
    let n = 0, sx = 0, sy = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { n++; sx += x; sy += y; }
    const cx = sx / n, cy = sy / n;
    let m20 = 0, m02 = 0, m11 = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) {
      const dx = x - cx, dy = y - cy; m20 += dx * dx; m02 += dy * dy; m11 += dx * dy;
    }
    m20 /= n; m02 /= n; m11 /= n;
    return { cx, cy, area: n, theta: 0.5 * Math.atan2(2 * m11, m20 - m02), m20, m02, m11 };
  }
  function shapeStats(sil, w, h) {
    const m = moments(sil, w, h);
    const tr = m.m20 + m.m02, det = m.m20 * m.m02 - m.m11 * m.m11;
    const disc = Math.sqrt(Math.max(tr * tr / 4 - det, 0));
    const l1 = tr / 2 + disc, l2 = Math.max(tr / 2 - disc, 1e-9);
    return { area: m.area, elong: Math.sqrt(l1 / l2), fill: m.area / (12 * Math.sqrt(l1 * l2)), cx: m.cx, cy: m.cy };
  }
  function boundaryMask(mask, w, h) {
    const er = erode(mask, w, h, 3), out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = mask[i] && !er[i] ? 1 : 0;
    return out;
  }
  function median(arr) {
    const a = Float64Array.from(arr).sort();
    const n = a.length;
    return n % 2 ? a[(n - 1) / 2] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
  }
  function percentileSorted(a, p) {
    const pos = (a.length - 1) * p / 100, lo = Math.floor(pos), hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }

  // ------------------------------------------------------------------ exact EDT (Felzenszwalb)
  function edt1d(f, n, d, arg, v, z) {
    let k = -1;
    for (let q = 0; q < n; q++) {
      if (f[q] >= INF) continue;
      if (k < 0) { k = 0; v[0] = q; z[0] = -Infinity; z[1] = Infinity; continue; }
      let s;
      for (;;) {
        const p = v[k];
        s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
        if (s <= z[k]) k--; else break;
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    if (k < 0) { for (let q = 0; q < n; q++) { d[q] = INF; arg[q] = -1; } return; }
    let j = 0;
    for (let q = 0; q < n; q++) {
      while (z[j + 1] < q) j++;
      const p = v[j];
      d[q] = (q - p) * (q - p) + f[p]; arg[q] = p;
    }
  }
  // distance (and nearest feature pixel) to the nearest pixel where feat is true
  function edt(feat, w, h, wantNearest) {
    const n = Math.max(w, h);
    const f = new Float64Array(n), d = new Float64Array(n), arg = new Int32Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    const colD = new Float64Array(w * h), colY = new Int32Array(w * h);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = feat[y * w + x] ? 0 : INF;
      edt1d(f, h, d, arg, v, z);
      for (let y = 0; y < h; y++) { colD[y * w + x] = d[y]; colY[y * w + x] = arg[y]; }
    }
    const dist = new Float32Array(w * h);
    const near = wantNearest ? new Int32Array(w * h * 2) : null;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) f[x] = colD[y * w + x];
      edt1d(f, w, d, arg, v, z);
      for (let x = 0; x < w; x++) {
        dist[y * w + x] = d[x] >= INF ? 1e6 : Math.sqrt(d[x]);
        if (near) { const qx = arg[x]; near[2 * (y * w + x)] = qx; near[2 * (y * w + x) + 1] = qx >= 0 ? colY[y * w + qx] : -1; }
      }
    }
    return { dist, near };
  }
  const distTo = (mask, w, h) => edt(mask, w, h, false).dist;

  // ------------------------------------------------------------------ template
  let T = null;
  function decodeTemplate(json) {
    const bin = typeof atob === 'function' ? atob(json.rle) : Buffer.from(json.rle, 'base64').toString('binary');
    const W = json.w, H = json.h, z5 = new Uint8Array(W * H);
    let i = 0, o = 0;
    while (i < bin.length) {
      const v = bin.charCodeAt(i++);
      let run = 0, shift = 0, b;
      do { b = bin.charCodeAt(i++); run |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
      z5.fill(v, o, o + run); o += run;
    }
    return { W, H, z5 };
  }
  function init(json) {
    const { W, H, z5 } = decodeTemplate(json);
    const N = W * H, zones = new Uint8Array(N), lines = new Uint8Array(N), ctr = new Uint8Array(N), sil = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const v = z5[i] === 5 ? 4 : z5[i];
      zones[i] = v; lines[i] = v === 4 ? 1 : 0; ctr[i] = z5[i] === 5 ? 1 : 0; sil[i] = v !== 0 ? 1 : 0;
    }
    const mk = (fn) => { const m = new Uint8Array(N); for (let i = 0; i < N; i++) m[i] = fn(i) ? 1 : 0; return m; };
    const silNear = edt(boundaryMask(sil, W, H), W, H, true).near;
    const ctrNear = edt(ctr, W, H, true).near;
    const dOut = distTo(sil, W, H);
    const dLines = distTo(lines, W, H);
    const nonLine = mk(i => !lines[i]);
    const nl = edt(nonLine, W, H, true).near;
    const eff = new Uint8Array(N);
    for (let i = 0; i < N; i++) eff[i] = zones[nl[2 * i + 1] * W + nl[2 * i]];
    const A = distTo(mk(i => zones[i] === Z.OUT), W, H);
    const B = distTo(mk(i => zones[i] === Z.EN), W, H);
    const C = distTo(mk(i => zones[i] === Z.DE), W, H);
    const D = distTo(mk(i => zones[i] === Z.PU), W, H);
    const ip = distTo(mk(i => eff[i] !== Z.PU), W, H);
    const S = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (eff[i] === Z.EN) S[i] = A[i] / Math.max(A[i] + C[i], 1e-3);
      else if (eff[i] === Z.DE) { const o = Math.min(A[i], B[i]); S[i] = 1 + o / Math.max(o + D[i], 1e-3); }
      else if (eff[i] === Z.PU) S[i] = 2 + Math.min(1, ip[i] / 30);
    }
    const ctrPts = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ctr[y * W + x]) ctrPts.push(x, y);
    T = {
      W, H, zones, lines, sil, silNear, ctrNear, S, eff,
      nearSil: mk(i => dOut[i] <= 20),
      linesX: mk(i => dLines[i] <= P.LINE_EXCL),
      pulpRing: mk(i => (lines[i] && D[i] <= 4) || zones[i] === Z.PU),
      outBand: mk(i => dOut[i] >= 6 && dOut[i] <= 30),
      outIdx: Int32Array.from((function () { const a = []; for (let i = 0; i < N; i++) if (dOut[i] >= 6 && dOut[i] <= 30) a.push(i); return a; })()),
      ctrPts: Int32Array.from(ctrPts),
      m: moments(sil, W, H),
    };
    return T;
  }

  // ------------------------------------------------------------------ tooth search
  function toothCandidates(ink, w, h, top, thr, lo, centrePrior) {
    let dark;
    if (lo != null) dark = hysteresis(ink, w, h, thr, lo);
    else { dark = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) dark[i] = ink[i] > thr ? 1 : 0; }
    const cc = components(dark, w, h, true);
    const cands = [];
    for (let k = 1; k <= cc.n; k++) {
      const x = cc.x0[k], y = cc.y0[k], bw = cc.x1[k] - x + 1, bh = cc.y1[k] - y + 1, a = cc.area[k];
      if (a < 300 || Math.max(bw, bh) < 0.12 * Math.max(w, h)) continue;
      const sub = new Uint8Array(bw * bh), vals = [];
      for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) {
        const i = (y + yy) * w + (x + xx);
        if (cc.lab[i] === k) { sub[yy * bw + xx] = 1; vals.push(ink[i]); }
      }
      let sil = null, dens = 1;
      for (const ck of [1, 3, 5, 7, 9]) {
        sil = fillOutline(ck > 1 ? closing(sub, bw, bh, ck) : sub, bw, bh);
        let s = 0; for (let i = 0; i < sil.length; i++) s += sil[i];
        dens = a / Math.max(s, 1);
        if (dens < 0.5) break;
      }
      const st = shapeStats(sil, bw, bh);
      let score = st.area * Math.exp(-(((st.elong - P.TPL_ELONG) / 0.4) ** 2)) * Math.exp(-(((st.fill - P.TPL_FILL) / 0.2) ** 2));
      if (dens > P.TPL_DENSITY) score *= Math.exp(-(((dens - P.TPL_DENSITY) / 0.2) ** 2));
      if (x <= 1 || y <= 1 || x + bw >= w - 1 || y + bh >= h - 1) score *= 0.1;
      if (centrePrior) {
        const d = Math.hypot(x + st.cx - w / 2, y + st.cy - h / 2) / Math.hypot(w, h);
        score *= Math.exp(-((d / 0.2) ** 2));
      }
      cands.push({ score, box: [x, y, bw, bh], sub: sil, lineInk: median(vals) });
    }
    cands.sort((p, q) => q.score - p.score);
    return cands.slice(0, top).map(c => {
      const [x, y, bw, bh] = c.box, m = new Uint8Array(w * h);
      for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) m[(y + yy) * w + x + xx] = c.sub[yy * bw + xx];
      return { sil: m, box: c.box, lineInk: c.lineInk };
    });
  }

  // ------------------------------------------------------------------ registration
  function pointsOf(mask, w, h, maxN) {
    let n = 0;
    for (let i = 0; i < w * h; i++) if (mask[i]) n++;
    const xs = new Float64Array(n), ys = new Float64Array(n);
    let k = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { xs[k] = x; ys[k] = y; k++; }
    if (!maxN || n <= maxN) return { x: xs, y: ys, n };
    const sx = new Float64Array(maxN), sy = new Float64Array(maxN);
    for (let i = 0; i < maxN; i++) { const j = Math.floor(i * (n - 1) / (maxN - 1)); sx[i] = xs[j]; sy[i] = ys[j]; }
    return { x: sx, y: sy, n: maxN };
  }
  function initFromMoments(m, t, flip) {
    const s = Math.sqrt(t.area / m.area), th = t.theta - m.theta + (flip ? Math.PI : 0);
    const c = Math.cos(th) * s, si = Math.sin(th) * s;
    return [c, -si, t.cx - (c * m.cx - si * m.cy), si, c, t.cy - (si * m.cx + c * m.cy), 0, 0, 1];
  }
  function icp(pts, near, M, iters, model, maxR, keep) {
    const { W, H } = T;
    const fit = model === 'similarity' ? fitSimilarity : model === 'affine' ? fitAffine : fitHomography;
    const n = pts.n, qx = new Float64Array(n), qy = new Float64Array(n), tx = new Float64Array(n), ty = new Float64Array(n),
      r = new Float64Array(n), ok = new Uint8Array(n);
    const project = (Mc) => {
      let m = 0;
      for (let i = 0; i < n; i++) {
        const [u, v] = applyH(Mc, pts.x[i], pts.y[i]);
        ok[i] = (u >= 0 && u <= W - 1 && v >= 0 && v <= H - 1) ? 1 : 0;
        if (!ok[i]) continue;
        const j = Math.round(v) * W + Math.round(u);
        qx[i] = u; qy[i] = v; tx[i] = near[2 * j]; ty[i] = near[2 * j + 1];
        r[i] = Math.hypot(u - tx[i], v - ty[i]); m++;
      }
      return m;
    };
    for (let it = 0; it < iters; it++) {
      const m = project(M);
      if (m < 30) break;
      const rs = new Float64Array(m);
      let k = 0;
      for (let i = 0; i < n; i++) if (ok[i]) rs[k++] = r[i];
      rs.sort();
      const thr = Math.min(Math.max(percentileSorted(rs, keep), 1.5), maxR);
      const sx = [], sy = [], dx = [], dy = [];
      for (let i = 0; i < n; i++) if (ok[i] && r[i] <= thr) { sx.push(pts.x[i]); sy.push(pts.y[i]); dx.push(tx[i]); dy.push(ty[i]); }
      if (sx.length < 30) break;
      const Mn = fit(sx, sy, dx, dy, sx.length);
      if (!Mn) break;
      let diff = 0;
      for (let i = 0; i < 9; i++) diff = Math.max(diff, Math.abs(Mn[i] - M[i]));
      M = Mn;
      if (diff < 1e-5) break;
    }
    return M;
  }
  // dst(x, y) = src(M^-1 (x, y)), bilinear, 0 outside
  function warp(src, sw, sh, M, W, H, border) {
    const bv = border || 0, Mi = inv3(M), out = new Float32Array(W * H);
    if (bv) out.fill(bv);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const w = Mi[6] * x + Mi[7] * y + Mi[8];
      const u = (Mi[0] * x + Mi[1] * y + Mi[2]) / w, v = (Mi[3] * x + Mi[4] * y + Mi[5]) / w;
      const x0 = Math.floor(u), y0 = Math.floor(v);
      if (x0 < -1 || y0 < -1 || x0 >= sw || y0 >= sh) continue;
      const a = u - x0, b = v - y0, x1 = x0 + 1, y1 = y0 + 1;
      const inx0 = x0 >= 0, inx1 = x1 < sw, iny0 = y0 >= 0, iny1 = y1 < sh;
      const p00 = inx0 && iny0 ? src[y0 * sw + x0] : bv, p10 = inx1 && iny0 ? src[y0 * sw + x1] : bv;
      const p01 = inx0 && iny1 ? src[y1 * sw + x0] : bv, p11 = inx1 && iny1 ? src[y1 * sw + x1] : bv;
      out[y * W + x] = (p00 * (1 - a) + p10 * a) * (1 - b) + (p01 * (1 - a) + p11 * a) * b;
    }
    return out;
  }
  function thinPoints(cink) {
    const { W, H } = T, N = W * H, dark = new Uint8Array(N);
    for (let i = 0; i < N; i++) dark[i] = cink[i] > P.INK_T ? 1 : 0;
    const thick = opening(dark, W, H, 9), thin = new Uint8Array(N);
    for (let i = 0; i < N; i++) thin[i] = dark[i] && !thick[i] && T.nearSil[i] ? 1 : 0;
    return pointsOf(thin, W, H, 4000);
  }
  function qualityOf(cink) {
    const { W, H, ctrPts } = T;
    let cov = 0;
    const n = ctrPts.length / 2;
    for (let k = 0; k < n; k++) {
      const x = ctrPts[2 * k], y = ctrPts[2 * k + 1];
      let hit = 0;
      for (let dy = -2; dy <= 2 && !hit; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H && cink[yy * W + xx] > P.INK_T) { hit = 1; break; }
      }
      cov += hit;
    }
    cov /= n;
    let dirty = 0;
    const oi = T.outIdx;
    for (let k = 0; k < oi.length; k++) if (cink[oi[k]] > P.INK_T) dirty++;
    dirty /= Math.max(oi.length, 1);
    return cov * Math.max(0, 1 - 2 * dirty);
  }
  function correctionOk(C) {
    const [s1, s2] = svd2(C[0], C[1], C[3], C[4]);
    if (Math.min(s1, s2) < 0.8 || Math.max(s1, s2) > 1.25) return false;
    return Math.abs(C[6]) * T.W + Math.abs(C[7]) * T.H < 0.4;
  }
  function register(ink, w, h, sil) {
    const { W, H } = T;
    const m = moments(sil, w, h);
    const bpts = pointsOf(boundaryMask(sil, w, h), w, h, 2500);
    let best = null;
    for (const flip of [false, true]) {
      const M = icp(bpts, T.silNear, initFromMoments(m, T.m, flip), 40, 'similarity', 30, 80);
      const cink = warp(ink, w, h, M, W, H), q = qualityOf(cink);
      if (!best || q > best.q) best = { M, cink, q };
    }
    const attempt = (M2) => {
      if (!M2) return;
      const C = mul3(M2, inv3(best.M));
      for (let i = 0; i < 9; i++) C[i] /= C[8];
      if (!correctionOk(C)) return;
      const cink = warp(ink, w, h, M2, W, H), q = qualityOf(cink);
      if (q >= best.q - 0.005) best = { M: M2, cink, q };
    };
    attempt(icp(bpts, T.silNear, best.M, 40, 'affine', 15, 80));
    for (let round = 0; round < 2; round++) {
      for (const model of ['affine', 'homography']) {
        const pts = thinPoints(best.cink);
        if (pts.n < 100) break;
        const C = icp(pts, T.ctrNear, I3(), 30, model, 8, 85);
        attempt(mul3(C, best.M));
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ lesion + features
  function extractLesion(cink) {
    const { W, H, zones, linesX } = T, N = W * H;
    let cand = new Uint8Array(N);
    for (let i = 0; i < N; i++) cand[i] = cink[i] > P.LESION_T && zones[i] !== Z.OUT && !linesX[i] ? 1 : 0;
    cand = opening(cand, W, H, P.OPEN_K);
    const cc = components(cand, W, H, true);
    const bg = new Uint8Array(N);
    for (let i = 0; i < N; i++) bg[i] = cand[i] ? 0 : 1;
    const dt = distTo(bg, W, H);
    const thick = new Float32Array(cc.n + 1);
    for (let i = 0; i < N; i++) if (cc.lab[i] && dt[i] > thick[cc.lab[i]]) thick[cc.lab[i]] = dt[i];
    const core = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const l = cc.lab[i];
      if (l && cc.area[l] >= P.MIN_COMP && thick[l] >= P.MIN_THICK) core[i] = 1;
    }
    return core;
  }
  function reach(core, cink) {
    const { W, H, zones } = T, N = W * H;
    let r = core.slice();
    for (let it = 0; it < P.REACH; it++) {
      const d = dilate(r, W, H, 3);
      for (let i = 0; i < N; i++) if (d[i] && cink[i] > P.LESION_T && zones[i] !== Z.OUT) r[i] = 1;
    }
    return r;
  }
  function features(core, grown) {
    const { zones, S, pulpRing } = T, N = T.W * T.H;
    const f = { area: 0, a_en: 0, a_de: 0, a_pu: 0, contact: 0, depth: 0 };
    const idx = [];
    for (let i = 0; i < N; i++) {
      if (grown[i] && pulpRing[i]) f.contact++;
      if (!core[i]) continue;
      f.area++;
      if (zones[i] === Z.EN) f.a_en++; else if (zones[i] === Z.DE) f.a_de++; else if (zones[i] === Z.PU) f.a_pu++;
      idx.push(i);
    }
    f.deep = null;
    if (idx.length) {
      idx.sort((a, b) => S[b] - S[a]);
      const k = idx[Math.min(P.N_DEEP, idx.length) - 1];
      f.depth = S[k];
      f.deep = [k % T.W, Math.floor(k / T.W)];
    }
    return f;
  }
  function classify(f) {
    if (f.area < P.A_MIN) return 'normal';
    if (f.depth >= 2.0 || f.contact >= P.C_MIN) return 'pulp';
    if (f.depth >= P.T_DENTIN) return 'dentin';
    return 'enamel';
  }
  function finish(cink, extra) {
    const core = extractLesion(cink), grown = reach(core, cink), f = features(core, grown);
    f.pred = classify(f);
    return Object.assign(f, extra, { maps: Object.assign({ cink, core, grown }, extra.maps || {}) });
  }

  // ------------------------------------------------------------------ public entry points
  // img: {w, h, c: [Float32Array R, G, B]} (0..255). Returns a result object.
  function fineStage(img, box, scale0) {
    const [bx, by, bw, bh] = box.map(v => v / scale0);
    const m = 0.18 * Math.max(bw, bh);
    const x0 = Math.floor(Math.max(0, bx - m)), y0 = Math.floor(Math.max(0, by - m));
    const x1 = Math.floor(Math.min(img.w, bx + bw + m)), y1 = Math.floor(Math.min(img.h, by + bh + m));
    const cw = x1 - x0, ch = y1 - y0;
    if (cw < 8 || ch < 8) return null;
    const crop = { w: cw, h: ch, c: img.c.map(p => { const o = new Float32Array(cw * ch); for (let y = 0; y < ch; y++) o.set(p.subarray((y0 + y) * img.w + x0, (y0 + y) * img.w + x0 + cw), y * cw); return o; }) };
    const s = P.TOOTH_H / Math.max(bh, 1);
    const rw = Math.max(8, Math.round(cw * s)), rh = Math.max(8, Math.round(ch * s));
    const small = resizePlanes(crop, rw, rh, s < 1);
    let ink = inkMap(small);
    const c = toothCandidates(ink, rw, rh, 1, P.INK_T_COARSE, P.INK_T_LOW, true);
    if (!c.length) return null;
    const gain = Math.min(3, Math.max(1, P.LINE_INK / Math.max(c[0].lineInk, 1e-3)));
    for (let i = 0; i < ink.length; i++) ink[i] = Math.min(1, ink[i] * gain);
    let best = null;
    for (const cand of toothCandidates(ink, rw, rh, 3, P.INK_T, null, true)) {
      const r = register(ink, rw, rh, cand.sil);
      if (!best || r.q > best.q) best = Object.assign(r, { gain, crop: small, sil: cand.sil });
    }
    return best;
  }
  function analyseImage(img) {
    if (!T) throw new Error('engine not initialised');
    const scale0 = Math.min(1, P.WORK_LONG / Math.max(img.w, img.h));
    const cw = Math.round(img.w * scale0), ch = Math.round(img.h * scale0);
    const coarse = scale0 < 1 ? resizePlanes(img, cw, ch, true) : img;
    const ink0 = inkMap(coarse);
    let best = null;
    for (const cand of toothCandidates(ink0, coarse.w, coarse.h, 3, P.INK_T_COARSE, P.INK_T_LOW, false)) {
      const r = fineStage(img, cand.box, scale0);
      if (!r) continue;
      if (!best || r.q > best.q) best = r;
      if (r.q >= 0.9) break;
    }
    if (!best) return { ok: false, error: 'no_tooth' };
    const res = finish(best.cink, { quality: best.q, gain: best.gain, M: best.M, crop: best.crop, sil: best.sil });
    res.ok = true;
    res.lowQuality = best.q < P.MIN_QUALITY;
    return res;
  }
  // paint: Uint8Array (W*H) in template coordinates
  function analyseDrawing(paint) {
    const { W, H, lines } = T, cink = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) cink[i] = paint[i] ? 0.95 : lines[i] ? 0.85 : 0;
    const res = finish(cink, { quality: 1, gain: 1 });
    res.ok = true; res.lowQuality = false;
    return res;
  }
  // warp the colour crop into the template frame for display
  function warpColour(crop, M) {
    return crop.c.map(p => warp(p, crop.w, crop.h, M, T.W, T.H, 255));
  }

  // ------------------------------------------------------------------ X-ray and tooth-photo helpers
  // A radiograph or a photo of a cut tooth has no printed lines to lock onto, so the fit uses the
  // tooth silhouette only and the person corrects it by hand. Images here are grey, 0..255.
  function otsu(vals) {
    const hist = new Float64Array(256);
    let n = 0, sum = 0;
    for (let i = 0; i < vals.length; i++) { const v = vals[i], b = v < 0 ? 0 : v > 255 ? 255 : v | 0; hist[b]++; n++; sum += b; }
    let wB = 0, sB = 0, best = -1, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sB += t * hist[t];
      const d = sB / wB - (sum - sB) / wF, v = wB * wF * d * d;
      if (v > best) { best = v; thr = t; }
    }
    return thr;
  }
  // Tooth-shaped blobs, most likely first. An X-ray has several grey levels (air < bone < dentin <
  // enamel), so blobs are cut at a few levels and with two opening sizes to split touching teeth.
  function toothBlobs(g, w, h) {
    const N = w * h, t1 = otsu(g), hi = [], lo = [];
    for (let i = 0; i < N; i++) (g[i] > t1 ? hi : lo).push(g[i]);
    const t2 = hi.length > 100 ? otsu(hi) : t1, t0 = lo.length > 100 ? otsu(lo) : t1;
    const cands = [], wholes = [];
    for (const [thr, bright] of [[t2, true], [(t1 + t2) / 2, true], [t1, true], [t1, false], [t0, false]]) {
      const m0 = new Uint8Array(N);
      for (let i = 0; i < N; i++) m0[i] = (g[i] > thr) === bright ? 1 : 0;
      for (const kf of [90, 40]) {
        const k = Math.max(3, Math.round(Math.min(w, h) / kf) | 1), m = opening(m0, w, h, k), cc = components(m, w, h, false);
        // the whole level as one candidate too: a deep lesion can cut a tooth's silhouette in two
        if (bright && kf === 90) wholes.push({ sil: fillOutline(closing(m, w, h, 2 * k + 1), w, h), whole: true });
        for (let l = 1; l <= cc.n; l++) {
          if (cc.area[l] < 0.02 * N) continue;
          const edges = (cc.x0[l] === 0) + (cc.y0[l] === 0) + (cc.x1[l] === w - 1) + (cc.y1[l] === h - 1);
          if (edges >= 3) continue;
          const blob = new Uint8Array(N);
          for (let i = 0; i < N; i++) if (cc.lab[i] === l) blob[i] = 1;
          const sil = fillOutline(closing(blob, w, h, 2 * k + 1), w, h), st = shapeStats(sil, w, h);
          const dx = st.cx / w - 0.5, dy = st.cy / h - 0.5;
          const score = Math.sqrt(st.area) * Math.exp(-(dx * dx + dy * dy) / 0.08) * Math.exp(-(((st.elong - P.TPL_ELONG) / 0.7) ** 2)) *
            Math.exp(-(((st.fill - P.TPL_FILL) / 0.3) ** 2)) * (bright ? 1 : 0.6) / (1 + edges);
          cands.push({ sil, score, area: st.area, cx: st.cx, cy: st.cy });
        }
      }
    }
    cands.sort((a, b) => b.score - a.score);
    const out = []; // drop near-duplicates (same blob found at another level)
    for (const c of cands) {
      if (out.some(o => Math.abs(o.area - c.area) < 0.05 * c.area && Math.hypot(o.cx - c.cx, o.cy - c.cy) < 0.03 * Math.max(w, h))) continue;
      out.push(c);
    }
    return { blobs: out, wholes };
  }
  // snap to the tooth under a placement the person made by hand: ICP from there on each grey level
  function refineFit(g, w, h, M0, FM) {
    FM = FM || shapeModel(false);
    const { wholes } = toothBlobs(g, w, h);
    let best = null;
    for (const c of wholes) {
      const b = pointsOf(boundaryMask(c.sil, w, h), w, h, 4000);
      if (b.n < 50) continue;
      const det = M0[0] * M0[4] - M0[1] * M0[3], F = det < 0 ? [-1, 0, w - 1, 0, 1, 0, 0, 0, 1] : I3();
      const pts = det < 0 ? { x: b.x.map(x => w - 1 - x), y: b.y, n: b.n } : b, start = mul3(M0, F);
      for (const model of ['similarity', 'affine']) {
        const Mm = icp(pts, FM.silNear, model === 'similarity' ? start : (best && best.F === F ? best.Mm : start), 30, model, 30, 80);
        if (!Mm) continue;
        if (model === 'affine') { const [s1, s2] = svd2(Mm[0], Mm[1], Mm[3], Mm[4]); if (s1 / Math.max(s2, 1e-9) > 1.6) continue; }
        const M = mul3(Mm, F), q = silIoU(c.sil, w, h, M, 2, FM);
        if (!best || q > best.q) best = { M, Mm, F, q, sil: c.sil };
      }
    }
    return best && { M: best.M, q: best.q, sil: best.sil };
  }
  // best fit of the reference tooth over the most likely blobs
  function autoFit(g, w, h, FM) {
    const { blobs, wholes } = toothBlobs(g, w, h);
    let best = null;
    for (const c of blobs.slice(0, 4).concat(wholes)) {
      if (c.whole && best && best.sel >= 0.85) break;
      const f = fitBlob(c.sil, w, h, c.whole, FM);
      if (f && (!best || f.sel > best.sel)) best = f;
      if (best && best.sel >= 0.92) break;
    }
    return best;
  }
  // Entry point for the page. With M0 (the person's own placement, image -> template), snap to the
  // tooth under it first; a snap there is trusted at a lower overlap than a search of the whole image.
  const FIT_OK = 0.75, FIT_LOCAL = 0.65, FIT_EDGE_Q = 0.58, FIT_EDGE_GAP = 5;
  // opts.crownOnly: fit the crown only (bite-wings); opts.localOnly: never search the whole image
  // (a tooth picked out of a panoramic image must stay the tooth that was picked).
  function xrayFit(g, w, h, M0, opts) {
    opts = opts || {};
    const FM = shapeModel(!!opts.crownOnly);
    let fit = M0 ? refineFit(g, w, h, M0, FM) : null;
    if (fit) fit.local = true;
    const ok = (f) => !!f && f.q >= (f.local ? FIT_LOCAL : FIT_OK);
    if (!ok(fit) && !opts.localOnly) { const g2 = autoFit(g, w, h, FM); if (g2 && (!fit || g2.q > fit.q + 0.05)) fit = g2; }
    if (!fit) return { M: null, q: 0, ok: false, gap: 60 };
    // Teeth that touch along their sides merge into one blob, which lowers the overlap of a correct
    // fit; a fit whose outline sits on the tooth's edges is accepted at a lower overlap.
    const gap = fit.sil ? edgeGap(fit.sil, w, h, fit.M, FM) : 60;
    return { M: fit.M, q: fit.q, ok: ok(fit) || (fit.q >= FIT_EDGE_Q && gap <= FIT_EDGE_GAP), gap };
  }
  // overlap of a fitted silhouette with the reference molar, ignoring anything more than 20 px
  // outside the outline (neighbouring teeth, bone), sampled on every second pixel
  // The shape a fit aims at: the whole reference tooth, or only its crown and neck (bite-wings show
  // no roots, so a root in the model would pull the fit off).
  function shapeModel(crownOnly) {
    const xr = xrayRefs();
    if (!crownOnly) return T.fullModel || (T.fullModel = { sil: T.sil, silNear: T.silNear, m: T.m, box: xr.box, near: xr.near });
    if (T.crownModel) return T.crownModel;
    const { W, H } = T, N = W * H, cut = Math.round(xr.cervY + 0.15 * xr.ch), sil = new Uint8Array(N), box = [W, H, -1, -1];
    for (let i = 0; i < N; i++) if (T.sil[i] && (i / W | 0) <= cut) {
      sil[i] = 1; const x = i % W, y = (i / W) | 0;
      box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
    }
    T.crownModel = { sil, silNear: edt(boundaryMask(sil, W, H), W, H, true).near, m: moments(sil, W, H), box, near: dilate(sil, W, H, 41), crownOnly: true };
    return T.crownModel;
  }
  // How far the template's own outline lies from the tooth's edges in the image, in template pixels
  // (median). The overlap score only looks near the template, so a narrow template sitting inside a
  // wide tooth can score well; this catches it. Used to choose between reference teeth.
  function edgeGap(sil, w, h, M, FM) {
    const tb = FM.bpts || (FM.bpts = pointsOf(boundaryMask(FM.sil, T.W, T.H), T.W, T.H, 600));
    const dist = edt(boundaryMask(sil, w, h), w, h, false).dist, Mi = inv3(M);
    const s = Math.sqrt(Math.abs(M[0] * M[4] - M[1] * M[3])), ds = [];
    for (let k = 0; k < tb.n; k++) {
      const x = tb.x[k], y = tb.y[k], ww = Mi[6] * x + Mi[7] * y + Mi[8];
      const u = Math.round((Mi[0] * x + Mi[1] * y + Mi[2]) / ww), v = Math.round((Mi[3] * x + Mi[4] * y + Mi[5]) / ww);
      ds.push(u >= 0 && v >= 0 && u < w && v < h ? Math.min(60, dist[v * w + u] * s) : 60);
    }
    return median(ds);
  }
  function silIoU(sil, w, h, M, step, FM) {
    FM = FM || shapeModel(false);
    const { W, H } = T, near = FM.near, Mi = inv3(M), st = step || 2;
    let inter = 0, uni = 0;
    for (let y = 0; y < H; y += st) for (let x = 0; x < W; x += st) {
      const i = y * W + x, ww = Mi[6] * x + Mi[7] * y + Mi[8];
      const u = Math.round((Mi[0] * x + Mi[1] * y + Mi[2]) / ww), v = Math.round((Mi[3] * x + Mi[4] * y + Mi[5]) / ww);
      const a = near[i] && u >= 0 && v >= 0 && u < w && v < h && sil[v * w + u] === 1, b = FM.sil[i] === 1;
      if (a && b) inter++;
      if (a || b) uni++;
    }
    return uni ? inter / uni : 0;
  }
  // Fit a silhouette onto the reference molar, either way round and either way up, then a mild
  // affine. Starts from the blob's moments and, for a blob wider than one tooth (neighbours touching
  // at the contact points), from upright and tilted guesses spread across it, sized from its height.
  // Every start gets a few quick ICP rounds; only the best few are run to convergence. With several
  // teeth in view, a tooth near the middle of the image wins over an equally good one at the side.
  function fitBlob(sil, w, h, wide, FM) {
    FM = FM || shapeModel(false);
    const m = moments(sil, w, h), b = pointsOf(boundaryMask(sil, w, h), w, h, wide ? 4000 : 2500), box = FM.box;
    if (b.n < 50) return null;
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (sil[y * w + x]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const tH = box[3] - box[1] + 1, tW = box[2] - box[0] + 1, bcx = (box[0] + box[2]) / 2, bcy = (box[1] + box[3]) / 2;
    const judge = (M, step) => {
      const q = silIoU(sil, w, h, M, step, FM), Mi = inv3(M), ww = Mi[6] * bcx + Mi[7] * bcy + Mi[8];
      const ix = (Mi[0] * bcx + Mi[1] * bcy + Mi[2]) / ww, iy = (Mi[3] * bcx + Mi[4] * bcy + Mi[5]) / ww;
      const dn = Math.hypot(ix - w / 2, iy - h / 2) / (0.5 * Math.max(w, h));
      // The tooth that matters is near the middle (a single-tooth image, or a crop around a tap). Decay
      // notches a tooth's outline, so a healthy neighbour can fit better: the middle has to win clearly.
      return { q, sel: q - 1.5 * dn * dn };
    };
    const runs = [];
    for (const mirror of [false, true]) {
      const F = mirror ? [-1, 0, w - 1, 0, 1, 0, 0, 0, 1] : I3();
      const pts = mirror ? { x: b.x.map(x => w - 1 - x), y: b.y, n: b.n } : b;
      const mm = mirror ? Object.assign({}, m, { cx: w - 1 - m.cx, theta: -m.theta }) : m;
      const inits = [initFromMoments(mm, FM.m, false), initFromMoments(mm, FM.m, true)];
      const bx0 = mirror ? w - 1 - x1 : x0, bx1 = mirror ? w - 1 - x0 : x1;
      for (const side of [false, true]) { // tooth upright, or lying on its side
        const span = side ? x1 - x0 + 1 : y1 - y0 + 1, across = (side ? y1 - y0 + 1 : x1 - x0 + 1) * tH / span;
        const s = tH / span, n = across > 1.3 * tW ? (wide ? 7 : 5) : 1, base = side ? Math.PI / 2 : 0;
        for (let j = 0; j < n; j++) for (const r of [0, Math.PI, 0.35, -0.35, Math.PI + 0.35, Math.PI - 0.35]) {
          const f = (j + 0.5) / n, rr = base + r;
          const px = side ? (bx0 + bx1) / 2 : bx0 + f * (bx1 - bx0), py = side ? y0 + f * (y1 - y0) : (y0 + y1) / 2;
          const c = Math.cos(rr) * s, si = Math.sin(rr) * s;
          inits.push([c, -si, bcx - (c * px - si * py), si, c, bcy - (si * px + c * py), 0, 0, 1]);
        }
      }
      for (const M0 of inits) {
        const Mm = icp(pts, FM.silNear, M0, 8, 'similarity', 30, 80);
        runs.push(Object.assign({ Mm, F, pts }, judge(mul3(Mm, F), 4)));
      }
    }
    runs.sort((a, b) => b.sel - a.sel);
    let best = null;
    for (const r of runs.slice(0, 4)) {
      const Mm = icp(r.pts, FM.silNear, r.Mm, 30, 'similarity', 30, 80), M = mul3(Mm, r.F), j = judge(M);
      if (!best || j.sel > best.sel) best = Object.assign({ M, Mm, F: r.F, pts: r.pts }, j);
    }
    const A = icp(best.pts, FM.silNear, best.Mm, 40, 'affine', 15, 80);
    if (A) {
      const [s1, s2] = svd2(A[0], A[1], A[3], A[4]), M = mul3(A, best.F), j = judge(M);
      if (s1 / Math.max(s2, 1e-9) < 1.6 && j.sel >= best.sel - 0.005) best = Object.assign(best, { M }, j);
    }
    return { M: best.M, q: best.q, sel: best.sel, sil };
  }
  function xrayRefs() {
    if (T.xr) return T.xr;
    const { W, H, zones, sil } = T, N = W * H;
    let cervY = 0, ex0 = W, ex1 = 0;
    for (let i = 0; i < N; i++) if (zones[i] === Z.EN) { const x = i % W; cervY = Math.max(cervY, (i / W) | 0); ex0 = Math.min(ex0, x); ex1 = Math.max(ex1, x); }
    const box = [W, H, -1, -1];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (sil[y * W + x]) {
      box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
    }
    const top = box[1], ch = cervY - top, midX = (ex0 + ex1) / 2, out = new Uint8Array(N);
    for (let i = 0; i < N; i++) out[i] = sil[i] ? 0 : 1;
    const dIn = distTo(out, W, H); // depth below the outer surface, for points inside the tooth
    // the neck of the tooth on each side, where cervical burn-out shows
    const neck = new Uint8Array(N);
    for (let y = Math.round(cervY - 0.21 * ch); y <= Math.round(cervY + 0.1 * ch); y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (sil[i] && dIn[i] <= 0.1 * ch) neck[i] = x < midX ? 1 : 2;
    }
    // root tips: given with the template, else the lowest point of the outline on each side
    let apex = T.apexPts;
    if (!apex) {
      apex = [[0, 0], [0, 0]];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (sil[y * W + x]) { const a = apex[x < midX ? 0 : 1]; if (y >= a[1]) { a[0] = x; a[1] = y; } }
    }
    T.xr = { cervY, top, ch, box, midX, crownHW: (ex1 - ex0) / 2, dIn, neck, apex, near: dilate(sil, W, H, 41), core: erode(sil, W, H, 21) };
    return T.xr;
  }
  // Grey levels of the crown in the template frame. Very bright patches (metal fillings, crowns,
  // root fillings) are radiopaque, so they are found first and kept out of the "sound tissue" levels.
  function frameStats(g, valid) {
    const { W, eff, outIdx } = T, N = g.length, { cervY, core } = xrayRefs();
    const en0 = [];
    for (let i = 0; i < N; i++) if (valid[i] && (i / W | 0) <= cervY && eff[i] === Z.EN) en0.push(g[i]);
    if (en0.length < 300) return null;
    const e25 = percentileSorted(Float64Array.from(en0).sort(), 25);
    const restoT = Math.max(e25 + 40, Math.min(250, e25 + 0.6 * (255 - e25)));
    let resto = new Uint8Array(N);
    for (let i = 0; i < N; i++) resto[i] = valid[i] && T.sil[i] && g[i] >= restoT ? 1 : 0;
    resto = opening(resto, T.W, T.H, 5);
    const cc = components(resto, T.W, T.H, true);
    let restoArea = 0, rootFill = 0;
    for (let i = 0; i < N; i++) {
      const l = cc.lab[i];
      if (!l || cc.area[l] < 150) { resto[i] = 0; continue; }
      if ((i / W | 0) > cervY + 30 && eff[i] === Z.PU) rootFill++; else restoArea++;
    }
    const en = [], de = [], inner = [], outer = [];
    for (let i = 0; i < N; i++) {
      if (!valid[i] || resto[i] || (i / W | 0) > cervY) continue;
      if (eff[i] === Z.EN) en.push(g[i]); else if (eff[i] === Z.DE) de.push(g[i]);
      if (core[i]) inner.push(g[i]);
    }
    for (let j = 0; j < outIdx.length; j++) { const i = outIdx[j]; if (valid[i] && (i / W | 0) <= cervY) outer.push(g[i]); }
    if (en.length < 200 || de.length < 300 || inner.length < 300) return null;
    const sorted = (a) => Float64Array.from(a).sort();
    const E = sorted(en), D = sorted(de), all = sorted(en.concat(de)), O = outer.length > 50 ? sorted(outer) : null;
    const mE = percentileSorted(E, 70), mD = percentileSorted(D, 70), mIn = median(inner);
    const c = Math.max(percentileSorted(all, 95) - percentileSorted(all, 5), 30);
    // On an X-ray the tooth is brighter than the air around the crown; on a photo of a cut tooth
    // it may be darker than the background. Only the first case can leave air inside the outline.
    const air = O ? percentileSorted(O, 30) : 0, bright = !O || mIn >= median(O);
    const airT = bright && O ? air + 0.3 * (mIn - air) : -1;
    return { mE, mD, mIn, c, air, bright, airT, resto, restoArea, rootFill, restoT };
  }
  const darkT = (st, k) => ({ tE: Math.max(st.mE, st.mD) - k * st.c - 0.5 * Math.max(st.mE - st.mD, 0), tD: st.mD - k * st.c });
  // share of each side of the tooth neck that is dark: burn-out darkens both sides alike
  function neckDark(g, valid, th) {
    const { eff } = T, { neck } = xrayRefs(), n = [0, 0, 0], d = [0, 0, 0];
    for (let i = 0; i < g.length; i++) {
      const s = neck[i];
      if (!s || !valid[i]) continue;
      n[s]++;
      if (g[i] < (eff[i] === Z.EN ? th.tE : th.tD)) d[s]++;
    }
    return [n[1] > 200 ? d[1] / n[1] : 0, n[2] > 200 ? d[2] / n[2] : 0];
  }
  // Dark (radiolucent) areas in the crown that open onto the tooth surface or a filling.
  // g: grey image already in the template frame (W*H); valid: 1 where the image covers the frame;
  // k: how much darker than sound tissue counts, as a share of the crown's contrast range.
  function findDark(g, valid, k) {
    const { W, H, eff, S } = T, N = W * H, { cervY, neck } = xrayRefs(), st = frameStats(g, valid);
    if (!st) return null;
    const th = darkT(st, k), { resto, airT } = st;
    let cand = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (!valid[i] || resto[i] || (i / W | 0) > cervY + 10) continue;
      if (eff[i] === Z.EN) cand[i] = g[i] < th.tE ? 1 : 0;
      else if (eff[i] === Z.DE) cand[i] = g[i] < th.tD ? 1 : 0;
    }
    cand = opening(cand, W, H, 5);
    const nearResto = st.restoArea ? dilate(resto, W, H, 9) : null;
    const cc = components(cand, W, H, true), n = cc.n;
    const minS = new Float32Array(n + 1).fill(9), maxS = new Float32Array(n + 1), airN = new Int32Array(n + 1),
      neckN = new Int32Array(n + 1), byResto = new Uint8Array(n + 1), keep = new Uint8Array(n + 1);
    for (let i = 0; i < N; i++) {
      const l = cc.lab[i];
      if (!l) continue;
      if (S[i] < minS[l]) minS[l] = S[i];
      if (S[i] > maxS[l]) maxS[l] = S[i];
      if (g[i] < airT) airN[l]++;
      if (neck[i]) neckN[l]++;
      if (nearResto && nearResto[i]) byResto[l] = 1;
    }
    // Burn-out: the neck of the tooth, covered by neither enamel nor bone, shows dark on both sides.
    const [nl, nr] = neckDark(g, valid, th), burnout = st.bright && nl >= 0.18 && nr >= 0.18;
    let dropped = 0, secondary = false;
    for (let l = 1; l <= n; l++) {
      // drop air-dark slivers along the outline, which a slightly-off fit leaves behind
      const airy = airN[l] > 0.6 * cc.area[l] || (airN[l] > 0.4 * cc.area[l] && maxS[l] < 0.6);
      const atNeck = neckN[l] >= 0.6 * cc.area[l];
      keep[l] = cc.area[l] >= 60 && (minS[l] <= 0.6 || byResto[l]) && !airy ? 1 : 0;
      if (keep[l] && burnout && atNeck) { keep[l] = 0; dropped += cc.area[l]; }
      if (keep[l] && byResto[l]) secondary = true;
    }
    const mask = new Uint8Array(N);
    let area = 0;
    for (let i = 0; i < N; i++) if (keep[cc.lab[i]]) { mask[i] = 1; area++; }
    return { mask, area, bright: st.bright, mE: st.mE, mD: st.mD, c: st.c, air: st.air, burnout, burnoutArea: dropped, neck: [nl, nr], secondary };
  }
  // where a lesion sits on the crown: the occlusal surface, a proximal (side) surface or the neck
  function lesionSite(core) {
    const { W, S, eff } = T, { cervY, midX, top, ch, crownHW } = xrayRefs(), votes = { occlusal: 0, proximal: 0, cervical: 0 };
    let best = 9, bi = -1, side = 0;
    const vote = (i) => {
      const x = i % W, y = (i / W) | 0;
      const site = y < top + 0.25 * ch && Math.abs(x - midX) <= 0.85 * crownHW ? 'occlusal' : y >= cervY - 0.23 * ch ? 'cervical' : 'proximal';
      votes[site]++; side += x < midX ? -1 : 1;
    };
    for (let i = 0; i < core.length; i++) if (core[i]) {
      if (S[i] < best) { best = S[i]; bi = i; }
      if (eff[i] === Z.EN && S[i] <= 0.35) vote(i);
    }
    if (bi < 0) return null;
    if (!votes.occlusal && !votes.proximal && !votes.cervical) vote(bi);
    const site = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0];
    return { site, side: side < 0 ? 'left' : 'right', fromSurface: best <= 0.35 };
  }
  // A dark halo around a root tip (compared with the bone a little further out) can be apical
  // periodontitis. Only judged when the image covers the root tips.
  function apexCheck(g, valid, c) {
    const { W, H, sil } = T, { apex, dIn } = xrayRefs();
    return apex.map(([ax, ay]) => {
      const r1 = [], r2 = [];
      let n1 = 0, n2 = 0;
      for (let y = Math.max(0, ay - 60); y < H; y++) for (let x = Math.max(0, ax - 60); x <= Math.min(W - 1, ax + 60); x++) {
        const i = y * W + x, d = Math.hypot(x - ax, y - ay);
        if (sil[i]) continue;
        if (d >= 5 && d <= 24 && y >= ay - 25) { n1++; if (valid[i]) r1.push(g[i]); }
        else if (d >= 32 && d <= 60 && y >= ay - 60) { n2++; if (valid[i]) r2.push(g[i]); }
      }
      if (n1 < 100 || n2 < 150 || r1.length < 0.85 * n1 || r2.length < 0.85 * n2) return { covered: false };
      const m1 = median(r1), m2 = median(r2), drop = (m2 - m1) / c;
      return { covered: true, dark: drop >= 0.12, drop, at: [ax, ay] };
    });
  }
  // How good is the image for reading decay? An ideal radiograph has high contrast; a grey,
  // too light or too dark film hides early lesions or exaggerates burn-out.
  function imageCheck(g, valid, st) {
    const v = [];
    for (let i = 0; i < g.length; i += 3) if (valid[i]) v.push(g[i]);
    if (v.length < 1000) return null;
    const s = Float64Array.from(v).sort(), range = percentileSorted(s, 98) - percentileSorted(s, 2);
    return { range, lowContrast: range < 80, dark: st.bright && st.mE < 115, light: st.bright && st.air > 115 };
  }
  // Everything the page reports beside the depth: site, fillings, burn-out, root tips, image quality.
  function inspect(g, valid, core, k) {
    const st = frameStats(g, valid);
    if (!st) return null;
    const th = darkT(st, k), [nl, nr] = neckDark(g, valid, th);
    let secondary = false;
    if (st.restoArea && core) {
      const near = dilate(st.resto, T.W, T.H, 9);
      for (let i = 0; i < core.length; i++) if (core[i] && near[i]) { secondary = true; break; }
    }
    return {
      site: core ? lesionSite(core) : null, filling: st.restoArea > 0, rootFilling: st.rootFill >= 100, secondary,
      burnout: st.bright && nl >= 0.18 && nr >= 0.18, neck: [nl, nr], apex: apexCheck(g, valid, st.c), image: imageCheck(g, valid, st),
    };
  }

  // Several reference teeth: each is built once (distance maps take a moment) and then switched to.
  const built = {};
  function select(name, json) {
    if (!built[name]) { if (!json) throw new Error('unknown template ' + name); init(json); T.name = name; T.apexPts = json.apex || null; built[name] = T; }
    T = built[name];
    return T;
  }

  const api = { P, Z, init, select, analyseImage, analyseDrawing, warpColour, classify, get T() { return T; },
    xray: { otsu, toothBlobs, fitBlob, autoFit, refineFit, fit: xrayFit, findDark, inspect, lesionSite, refs: () => xrayRefs(), shapeModel },
    _internal: { inkMap, resizeArea, resizeLinear, edt, components, fillOutline, toothCandidates, register, warp, fitHomography, fitAffine, fitSimilarity } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CariesEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);

