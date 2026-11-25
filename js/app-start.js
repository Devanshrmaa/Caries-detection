/* Printable diagram, install prompt, offline cache, first render. */
// ------------------------------------------------------------ printable PDF + install
function makePDF() {
  const pw = 595.28, ph = 841.89, sc = .74, ox = (pw - W * sc) / 2, oy = 118;
  const f = (v) => v.toFixed(2);
  let cs = 'BT /F2 18 Tf 56 ' + f(ph - 64) + ' Td (Caries depth diagram) Tj ET\n';
  cs += 'BT /F1 10.5 Tf 56 ' + f(ph - 84) + ' Td (Shade one lesion with a dark pen, marker or soft pencil.) Tj ET\n';
  cs += 'BT /F1 10.5 Tf 56 ' + f(ph - 99) + ' Td (Then photograph the whole tooth from above, in even light.) Tj ET\n';
  cs += '0.11 0.11 0.12 RG ' + f(4 * sc) + ' w 1 J 1 j\n';
  for (const [, d] of PATHS) {
    for (const part of d.split(/(?=[MLZ])/)) {
      const t = part.trim(), op = t[0];
      if (op === 'Z') { cs += 'h S\n'; continue; }
      const [x, y] = t.slice(1).split(',').map(Number);
      cs += f(ox + x * sc) + ' ' + f(ph - oy - y * sc) + (op === 'M' ? ' m\n' : ' l\n');
    }
  }
  cs += 'BT /F1 9 Tf 56 40 Td (Print at 100% on A4 or Letter. Caries Depth Checker, a teaching aid for this diagram.) Tj ET\n';
  const objs = ['', '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
    '<< /Length ' + cs.length + ' >>\nstream\n' + cs + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'];
  let pdf = '%PDF-1.4\n';
  const offs = [];
  for (let i = 1; i < objs.length; i++) { offs.push(pdf.length); pdf += i + ' 0 obj\n' + objs[i] + '\nendobj\n'; }
  const xref = pdf.length;
  pdf += 'xref\n0 ' + objs.length + '\n0000000000 65535 f \n' + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += 'trailer\n<< /Size ' + objs.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return new Blob([pdf], { type: 'application/pdf' });
}
$('#dl').onclick = () => {
  const url = URL.createObjectURL(makePDF()), a = document.createElement('a');
  a.href = url; a.download = 'caries-depth-diagram.pdf';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  $('#dlnote').textContent = 'Downloaded caries-depth-diagram.pdf. Print it at 100%.';
};

// install as an app (browsers that support it) and keep working offline
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#install').hidden = false; });
window.addEventListener('appinstalled', () => { installEvt = null; $('#install').hidden = true; });
$('#install').onclick = async () => {
  if (!installEvt) return;
  installEvt.prompt();
  try { await installEvt.userChoice; } catch (e) {}
  installEvt = null; $('#install').hidden = true;
};
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ------------------------------------------------------------ start
applyToggles();
drawPaper(gBase, K, 4, '#c7cdd3');
renderProbe(null);
openSample('dentin-middle');
