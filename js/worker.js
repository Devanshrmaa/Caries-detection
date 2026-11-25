/* Background thread: diagram photos and auto-fit run here so the page stays responsive. */
importScripts('templates.js', 'engine.js', 'analysis.js');
const E = self.CariesEngine, TPLS = self.CARIES_TEMPLATES;
E.select('molar', TPLS.molar);
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') { self.postMessage({ type: 'ready' }); return; }
  if (m.type === 'fit') {
    let fit = null;
    try { const name = TPLS[m.tpl] ? m.tpl : 'molar'; E.select(name, TPLS[name]); fit = E.xray.fit(new Float32Array(m.buf), m.w, m.h, m.M0, m.opts); }
    catch (err) { fit = null; }
    self.postMessage({ type: 'result', id: m.id, fit });
    return;
  }
  let out;
  try { E.select('molar', TPLS.molar); out = runAnalysis(E, m.w, m.h, new Uint8ClampedArray(m.buf)); }
  catch (err) { out = { res: { ok: false, error: 'crash', message: String(err && err.message || err) } }; }
  out.id = m.id; out.type = 'result';
  self.postMessage(out, out.view ? [out.view.buffer, out.core.buffer, out.grown.buffer, out.thumb.buffer] : []);
};
