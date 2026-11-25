/* Whole-image analysis for X-rays with many teeth (panoramic, bite-wing): what kind of image it is,
 * where the bite line runs between upper and lower teeth, metal objects (fillings, crowns, root
 * fillings, implants), how the head was positioned, and which tooth a tap lands on.
 * Pure functions on a grey image (Float32Array, 0..255, row-major); no page state. */
(function (root) {
  'use strict';

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  function percentile(arr, p) {
    const a = Float32Array.from(arr).sort();
    if (!a.length) return 0;
    const pos = (a.length - 1) * p / 100, lo = Math.floor(pos), hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }
  function resize(g, w, h, dw, dh) { // box-filter downscale
    const out = new Float32Array(dw * dh), cnt = new Float32Array(dw * dh);
    for (let y = 0; y < h; y++) {
      const yy = Math.min(dh - 1, (y * dh / h) | 0);
      for (let x = 0; x < w; x++) { const j = yy * dw + Math.min(dw - 1, (x * dw / w) | 0); out[j] += g[y * w + x]; cnt[j]++; }
    }
    for (let i = 0; i < out.length; i++) out[i] /= Math.max(cnt[i], 1);
    return out;
  }
  function blurCols(g, w, h, r) { // vertical box blur
    const out = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let y = 0; y < Math.min(h, r); y++) { s += g[y * w + x]; n++; }
      for (let y = 0; y < h; y++) {
        const a = y + r, b = y - r - 1;
        if (a < h) { s += g[a * w + x]; n++; }
        if (b >= 0) { s -= g[b * w + x]; n--; }
        out[y * w + x] = s / n;
      }
    }
    return out;
  }
  function blurRows(g, w, h, r) {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let s = 0, n = 0;
      for (let x = 0; x < Math.min(w, r); x++) { s += g[y * w + x]; n++; }
      for (let x = 0; x < w; x++) {
        const a = x + r, b = x - r - 1;
        if (a < w) { s += g[y * w + a]; n++; }
        if (b >= 0) { s -= g[y * w + b]; n--; }
        out[y * w + x] = s / n;
      }
    }
    return out;
  }

  // ------------------------------------------------------------ image type
  // rgb: {mean, dark, sat} from a small colour copy; g/w/h: grey image
  function classify(g, w, h, rgb) {
    const aspect = w / h;
    if (rgb.mean > 170 && rgb.dark < 0.08) return { type: 'diagram', why: 'Mostly white paper with dark lines.' };
    if (rgb.sat > 0.18) return { type: 'photo', why: 'A colour photo, so treated as a photo of one tooth.' };
    if (aspect >= 1.65) return { type: 'panoramic', why: 'A wide image, as panoramic X-rays are.' };
    // two rows of crowns with a dark gap between them, bright above and below: a bite-wing
    const occ = biteLine(g, w, h, 'bitewing');
    if (aspect >= 1.05 && occ && occ.strength > 0.16 && occ.cover > 0.55) return { type: 'bitewing', why: 'Upper and lower crowns facing each other across the bite.' };
    return { type: 'periapical', why: 'One row of teeth with their roots.' };
  }

  // ------------------------------------------------------------ the bite line (occlusal plane)
  // A smooth path through the dark gap between upper and lower crowns: each column scores how much
  // darker a point is than the brightest crown above and below it, and dynamic programming finds the
  // smoothest path through the darkest gaps. Works on a copy about 400 px wide.
  function biteLine(g, w, h, type) {
    const sw = Math.min(400, w), sh = Math.max(40, Math.round(h * sw / w)), sg = blurRows(blurCols(resize(g, w, h, sw, sh), sw, sh, 1), sw, sh, 2);
    const pano = type === 'panoramic';
    const y0 = Math.round(sh * (pano ? 0.28 : 0.2)), y1 = Math.round(sh * (pano ? 0.72 : 0.8));
    const d1 = Math.max(3, Math.round(sh * (pano ? 0.11 : 0.22))), d2 = Math.max(1, Math.round(sh * 0.012));
    const x0 = pano ? Math.round(sw * 0.08) : 0, x1 = pano ? Math.round(sw * 0.92) : sw - 1;
    const lo = percentile(sg, 5), hi = percentile(sg, 99), rng = Math.max(hi - lo, 20);
    const ny = y1 - y0 + 1, nx = x1 - x0 + 1, cost = new Float32Array(nx * ny);
    for (let xi = 0; xi < nx; xi++) {
      const x = x0 + xi;
      for (let yi = 0; yi < ny; yi++) {
        const y = y0 + yi;
        let up = 0, dn = 0;
        for (let k = d2; k <= d1; k++) {
          if (y - k >= 0) up = Math.max(up, sg[(y - k) * sw + x]);
          if (y + k < sh) dn = Math.max(dn, sg[(y + k) * sw + x]);
        }
        cost[xi * ny + yi] = (sg[y * sw + x] - Math.min(up, dn)) / rng; // negative = a dark gap between bright crowns
      }
    }
    // dynamic programming: steps of at most 2 rows per column, with a small penalty per row
    const acc = new Float32Array(nx * ny), from = new Int8Array(nx * ny), lam = 0.02;
    for (let yi = 0; yi < ny; yi++) acc[yi] = cost[yi];
    for (let xi = 1; xi < nx; xi++) for (let yi = 0; yi < ny; yi++) {
      let best = Infinity, bd = 0;
      for (let d = -2; d <= 2; d++) {
        const yy = yi + d;
        if (yy < 0 || yy >= ny) continue;
        const v = acc[(xi - 1) * ny + yy] + lam * Math.abs(d);
        if (v < best) { best = v; bd = d; }
      }
      acc[xi * ny + yi] = best + cost[xi * ny + yi];
      from[xi * ny + yi] = bd;
    }
    let yi = 0;
    for (let k = 1; k < ny; k++) if (acc[(nx - 1) * ny + k] < acc[(nx - 1) * ny + yi]) yi = k;
    const path = new Float32Array(nx), depth = new Float32Array(nx);
    for (let xi = nx - 1; xi >= 0; xi--) { path[xi] = y0 + yi; depth[xi] = -cost[xi * ny + yi]; if (xi) yi += from[xi * ny + yi]; }
    // where there are teeth on both sides of the line (a clear gap): the dental arch
    const strong = Array.from(depth).map(v => v > 0.12);
    let a = -1, b = -1, n = 0;
    for (let i = 0; i < nx; i++) if (strong[i]) { if (a < 0) a = i; b = i; n++; }
    if (a < 0) return null;
    const cover = n / nx, strength = percentile(depth.subarray(a, b + 1), 50);
    // parabola y = p0 + p1 t + p2 t^2 over the arch, t in -1..1, fitted to the columns with a clear gap
    const sums = new Float64Array(9), rhs = new Float64Array(3), mid = (a + b) / 2, half = Math.max((b - a) / 2, 1);
    for (let i = a; i <= b; i++) {
      if (!strong[i]) continue;
      const t = (i - mid) / half, row = [1, t, t * t];
      for (let r = 0; r < 3; r++) { rhs[r] += row[r] * path[i]; for (let c = 0; c < 3; c++) sums[r * 3 + c] += row[r] * row[c]; }
    }
    const P = solve3(sums, rhs) || [percentile(path, 50), 0, 0];
    const sx = w / sw, sy = h / sh;
    return {
      x0: x0 * sx, sx, sy, path: Array.from(path, v => v * sy), depth: Array.from(depth),
      archL: (x0 + a) * sx, archR: (x0 + b) * sx, cover, strength,
      // y of the bite line at image x (the smoothed parabola inside the arch, the path outside it)
      fit: { p0: P[0] * sy, p1: P[1] * sy, p2: P[2] * sy, mid: (x0 + mid) * sx, half: half * sx },
    };
  }
  function solve3(A, b) {
    const m = Array.from(A), v = Array.from(b);
    for (let c = 0; c < 3; c++) {
      let p = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(m[r * 3 + c]) > Math.abs(m[p * 3 + c])) p = r;
      if (Math.abs(m[p * 3 + c]) < 1e-9) return null;
      for (let k = 0; k < 3; k++) { const t = m[c * 3 + k]; m[c * 3 + k] = m[p * 3 + k]; m[p * 3 + k] = t; }
      const t = v[c]; v[c] = v[p]; v[p] = t;
      for (let r = c + 1; r < 3; r++) { const f = m[r * 3 + c] / m[c * 3 + c]; for (let k = c; k < 3; k++) m[r * 3 + k] -= f * m[c * 3 + k]; v[r] -= f * v[c]; }
    }
    const x = [0, 0, 0];
    for (let r = 2; r >= 0; r--) { let s = v[r]; for (let k = r + 1; k < 3; k++) s -= m[r * 3 + k] * x[k]; x[r] = s / m[r * 3 + r]; }
    return x;
  }
  // y of the bite line at x, and its slope (dy/dx)
  function biteAt(occ, x) {
    const f = occ.fit, t = (x - f.mid) / f.half;
    if (Math.abs(t) <= 1.05) return { y: f.p0 + f.p1 * t + f.p2 * t * t, slope: (f.p1 + 2 * f.p2 * t) / f.half };
    const i = clamp(Math.round((x - occ.x0) / occ.sx), 0, occ.path.length - 1);
    return { y: occ.path[i], slope: 0 };
  }

  // ------------------------------------------------------------ positioning (panoramic)
  // From the atlas: the bite line should curve up slightly towards the back (a gentle "smile").
  // A deep smile means the chin was tipped down; a flat or upside-down curve means it was tipped up.
  // A line that climbs to one side means the head was tilted or turned.
  function positioning(occ, w, h) {
    if (!occ) return null;
    // sag: how much lower the middle of the bite line is than its ends, as a share of the arch width
    const f = occ.fit, sag = -f.p2 / (2 * f.half), tilt = Math.atan2(f.p1, f.half) * 180 / Math.PI;
    const out = { sag, tilt, notes: [] };
    if (sag > 0.11) out.notes.push(['chin-down', 'Deep "smile" curve: the chin was probably tipped down. Upper premolars overlap and the jaw joints sit high.']);
    else if (sag < 0.012) out.notes.push(['chin-up', 'Flat or upside-down bite line: the chin was probably tipped up. The hard palate can hide the roots of the upper teeth.']);
    if (Math.abs(tilt) > 3) out.notes.push(['tilted', `The bite line climbs ${Math.abs(tilt).toFixed(0)}° to one side: the head was tilted or turned, so the two sides are not equally sharp or equally sized.`]);
    return out;
  }

  // ------------------------------------------------------------ metal objects
  // Metal stops X-rays and shows as flat, saturated white. Components are sorted by where they sit
  // and their shape: at the crowns = filling or crown; long and thin inside a root = root filling;
  // thick and long in the bone below or above the crowns = implant (or a post).
  function metal(g, w, h, occ, type) {
    const sw = Math.min(600, w), sh = Math.max(30, Math.round(h * sw / w)), sg = resize(g, w, h, sw, sh), N = sw * sh;
    const p995 = percentile(sg, 99.5), p90 = percentile(sg, 90);
    const thr = Math.max(238, p995 - 4);
    if (p995 < 230 || p995 - p90 < 25) return { thr, items: [] };
    let m = new Uint8Array(N);
    for (let i = 0; i < N; i++) m[i] = sg[i] >= thr ? 1 : 0;
    // close small gaps (the threads of an implant, the edge of a crown) so one object stays one object
    const grow = (src, isMax) => {
      const out = new Uint8Array(N);
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        let v = isMax ? 0 : 1;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy, q = xx < 0 || yy < 0 || xx >= sw || yy >= sh ? (isMax ? 0 : 1) : src[yy * sw + xx];
          if (isMax ? q : !q) v = isMax ? 1 : 0;
        }
        out[y * sw + x] = v;
      }
      return out;
    };
    m = grow(grow(m, true), false);
    // 4-connected components
    const lab = new Int32Array(N), items = [], keep = [];
    let n = 0;
    const st = [];
    for (let i = 0; i < N; i++) {
      if (!m[i] || lab[i]) continue;
      n++; st.length = 0; st.push(i); lab[i] = n;
      let area = 0, x0 = sw, y0 = sh, x1 = -1, y1 = -1, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      while (st.length) {
        const j = st.pop(), x = j % sw, y = (j / sw) | 0;
        area++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (const k of [j - 1, j + 1, j - sw, j + sw]) {
          if (k < 0 || k >= N || lab[k] || !m[k]) continue;
          if ((k === j - 1 && x === 0) || (k === j + 1 && x === sw - 1)) continue;
          lab[k] = n; st.push(k);
        }
      }
      const minA = type === 'panoramic' ? 18 : 40;
      if (area < minA) continue;
      keep.push(n);
      const cx = sx / area, cy = sy / area, vxx = sxx / area - cx * cx, vyy = syy / area - cy * cy, vxy = sxy / area - cx * cy;
      const tr = vxx + vyy, det = vxx * vyy - vxy * vxy, disc = Math.sqrt(Math.max(tr * tr / 4 - det, 0));
      const l1 = tr / 2 + disc, l2 = Math.max(tr / 2 - disc, 0.25), elong = Math.sqrt(l1 / l2), thick = 4 * Math.sqrt(l2);
      const s = w / sw;
      items.push({ x0: x0 * s, y0: y0 * s, x1: (x1 + 1) * s, y1: (y1 + 1) * s, cx: cx * s, cy: cy * s, area: area * s * s, elong, thick: thick * s });
    }
    // what each object probably is, from its place relative to the bite line
    const H = type === 'panoramic' ? h * 0.22 : h * 0.5; // about one tooth's length
    for (const it of items) {
      const b = occ ? biteAt(occ, it.cx).y : h / 2, dist = Math.abs(it.cy - b), far = Math.max(Math.abs(it.y0 - b), Math.abs(it.y1 - b));
      it.upper = it.cy < b;
      if (dist < 0.38 * H && far < 0.62 * H) it.kind = 'filling';
      else if (it.elong > 2.4 && it.thick < 0.07 * H) it.kind = 'root-filling';
      else if (it.elong > 1.8 && far > 0.55 * H) it.kind = 'implant';
      else it.kind = dist < 0.5 * H ? 'filling' : 'other';
    }
    // the kept objects as a mask (sw x sh), so a crop can carry them over
    const ks = new Uint8Array(n + 1); for (const k of keep) ks[k] = 1;
    const mask = new Uint8Array(N); for (let i = 0; i < N; i++) mask[i] = ks[lab[i]];
    return { thr, items, mask, mw: sw, mh: sh };
  }

  // ------------------------------------------------------------ which tooth a tap lands on
  // Average crown widths (mm), central incisor to third molar, used to turn a position along the
  // arch into a tooth number on a panoramic image.
  const WIDTHS = { upper: [8.5, 6.5, 7.5, 7, 6.5, 10, 9, 8.5], lower: [5.5, 6, 7, 7, 7, 11, 10.5, 10] };
  const KIND = ['incisor', 'incisor', 'incisor', 'premolar', 'premolar', 'molar', 'molar', 'molar'];
  // The gaps between neighbouring crowns show as dips in brightness along a band just inside the
  // crowns. Fitting the table of crown widths to those dips gives the size of the teeth in pixels, so
  // the numbering works with or without wisdom teeth. Returns { mid, k (px per mm) } for one jaw.
  // lcFrac: crown height as a share of the image height (panoramic about 0.08, bite-wing about 0.26)
  // band: the part of the crown sampled, as shares of the crown height from the biting edge
  // dark: keep only dips in the darker part of the profile (a gap is darker than a pulp horn)
  function arch(g, w, h, occ, upper, lcFrac, band, dark) {
    const Lc = h * (lcFrac || 0.08), cols = [], vals = [], [t0, t1] = band || [0.12, 0.54];
    const x0 = Math.max(0, Math.floor(occ.archL)), x1 = Math.min(w - 1, Math.ceil(occ.archR)), step = Math.max(1, Math.round(w / 800));
    for (let x = x0; x <= x1; x += step) {
      const b = biteAt(occ, x).y, sgn = upper ? -1 : 1;
      let s = 0, n = 0;
      // the biting half of the crown: lower down, the dark pulp inside each crown would show as a dip.
      // (The notch between a molar's cusps can show as a dip here; the width checks deal with that.)
      for (let j = 0; j <= 7; j++) { const t = t0 + (t1 - t0) * j / 7, y = Math.round(b + sgn * t * Lc); if (y >= 0 && y < h) { s += g[y * w + x]; n++; } }
      cols.push(x); vals.push(n ? s / n : 0);
    }
    // smooth a little, then find dips that stand out from the crowns on both sides
    const sm = vals.map((v, i) => { let s = 0, n = 0; for (let k = -2; k <= 2; k++) { const j = i + k; if (j >= 0 && j < vals.length) { s += vals[j]; n++; } } return s / n; });
    const lo = percentile(sm, 5), hi = percentile(sm, 95), prom = 0.12 * Math.max(hi - lo, 10), win = Math.max(3, Math.round(h * 0.03 / step));
    const dips = [];
    for (let i = 1; i < sm.length - 1; i++) {
      if (sm[i] > sm[i - 1] || sm[i] > sm[i + 1]) continue;
      let la = sm[i], ra = sm[i];
      for (let k = 1; k <= win; k++) { if (i - k >= 0) la = Math.max(la, sm[i - k]); if (i + k < sm.length) ra = Math.max(ra, sm[i + k]); }
      if (dark != null && sm[i] > percentile(sm, dark)) continue;
      if (Math.min(la, ra) - sm[i] >= prom && (!dips.length || cols[i] - dips[dips.length - 1] > h * 0.02)) dips.push(cols[i]);
    }
    const centre = (occ.archL + occ.archR) / 2, half = Math.max((occ.archR - occ.archL) / 2, w * 0.2);
    // the midline is the dip between the central incisors: the dip nearest the middle of the arch
    let mid = centre;
    const near = dips.filter(d => Math.abs(d - centre) < half * 0.12).sort((a, c) => Math.abs(a - centre) - Math.abs(c - centre));
    if (near.length) mid = near[0];
    return { mid, dips: dips.filter(d => d >= occ.archL && d <= occ.archR), half };
  }
  // Fit the table of crown widths to the dips of each jaw: the tooth size k (pixels per mm) that puts
  // the predicted gaps between teeth closest to the dips found. Each jaw on its own: their teeth differ
  // in width (lower incisors are much narrower).
  function arches(g, w, h, occ, lcFrac, band, dark) {
    const J = { upper: arch(g, w, h, occ, true, lcFrac, band, dark), lower: arch(g, w, h, occ, false, lcFrac, band, dark) };
    for (const jaw of ['upper', 'lower']) {
      const A = J[jaw], cum = [];
      WIDTHS[jaw].reduce((a, c) => (cum.push(a + c), a + c), 0);
      const k0 = A.half / cum[6]; // seven teeth per side
      let best = { k: k0, cost: Infinity };
      if (A.dips.length >= 4) {
        for (let k = k0 * 0.75; k <= k0 * 1.3; k += k0 * 0.004) {
          let cost = 0;
          for (const d of A.dips) {
            const r = Math.abs(d - A.mid);
            if (r < 2) continue;
            let m = Infinity; for (const c of cum) m = Math.min(m, Math.abs(r - k * c));
            cost += Math.min(m, 2.5 * k0); // a fixed cap, or small teeth would always win
          }
          if (cost < best.cost) best = { k, cost };
        }
      }
      A.k = best.k; A.fitted = best.cost < Infinity;
    }
    return J;
  }
  // FDI number: quadrant 1 upper right, 2 upper left, 3 lower left, 4 lower right (patient's sides:
  // on a panoramic image the patient's right is on the viewer's left)
  function toothAt(occ, x, y, type, arches) {
    const b = biteAt(occ, x), upper = y < b.y, jaw = upper ? 'upper' : 'lower';
    const res = { upper, bite: b };
    if (type !== 'panoramic' || !arches) return Object.assign(res, { fdi: null, pos: null, kind: null });
    const A = arches[jaw], ws = WIDTHS[jaw], r = Math.abs(x - A.mid) / A.k;
    let acc = 0, pos = 8;
    for (let k = 0; k < 8; k++) { acc += ws[k]; if (r <= acc) { pos = k + 1; break; } }
    const right = x < A.mid, q = upper ? (right ? 1 : 2) : (right ? 4 : 3);
    return Object.assign(res, { fdi: q * 10 + pos, pos, kind: KIND[pos - 1], crownW: ws[pos - 1] * A.k, mid: A.mid });
  }

  const api = { classify, biteLine, biteAt, positioning, metal, arch, arches, toothAt, percentile, WIDTHS, KIND };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DentalScan = api;
})(typeof self !== 'undefined' ? self : globalThis);
