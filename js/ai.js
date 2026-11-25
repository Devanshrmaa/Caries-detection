/* Optional AI second opinion: sends the image on screen to Claude with the person's own Anthropic API
 * key and lists what it sees, with boxes drawn on the image. Runs only when the button is pressed; the
 * SDK (about 370 KB) is loaded at that moment, not with the page. */
const $ = (s) => document.querySelector(s);
const KEY_STORE = 'cdc-anthropic-key';
const MODEL = 'claude-opus-5-5';

const SYSTEM = `You review dental images for a teaching tool that checks teeth for decay. The person using it may be a dental student, a dentist or a patient. Describe what is visible on the image; do not make a diagnosis and do not recommend treatment.

Report each finding you can see, with a box around it. Box coordinates run from 0 to 1 across the whole image: x0,y0 is the top-left corner of the box and x1,y1 the bottom-right corner. Make boxes tight around the finding.

Use FDI tooth numbers (11 to 48) when you can tell which tooth it is. On a panoramic X-ray the patient's right side is on the viewer's left. A single tooth cropped from a panoramic X-ray may have been turned so that its crown is at the top. Use an empty string when you cannot tell.

For decay, give how deep it reaches on the image: enamel, outer, middle or inner third of dentin, or pulp. Decay usually reaches further than a radiograph shows, and decay on the cheek or tongue side of a tooth rarely shows at all.

Watch for normal anatomy and artefacts that look like disease: cervical burn-out at the necks of teeth, overlapping contacts between teeth, the maxillary sinus and its recesses, the mental foramen near the roots of the lower premolars, the mandibular canal, soft-tissue and air shadows (tongue, soft palate, pharynx, lips), the hyoid bone, the spine over the chin, and ghost images of earrings or other jewellery. Report one of these only when it could be mistaken for a lesion, as category anatomy_lookalike.

Prefer fewer, well-founded findings over many guesses, and say how confident you are in each. Comment on image quality when it limits what can be seen. If the image is not a dental image, say so in the summary and return no findings.`;

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['image_type', 'image_quality', 'findings', 'summary'],
  properties: {
    image_type: { type: 'string', enum: ['panoramic', 'bitewing', 'periapical', 'occlusal', 'cropped_tooth', 'intraoral_photo', 'cut_tooth_photo', 'diagram', 'not_dental', 'other'] },
    image_quality: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['label', 'category', 'tooth', 'depth', 'confidence', 'box', 'note'],
        properties: {
          label: { type: 'string' },
          category: { type: 'string', enum: ['caries', 'secondary_caries', 'filling', 'crown', 'root_canal_filling', 'implant', 'periapical_lesion', 'bone_loss', 'calculus', 'impacted_tooth', 'missing_tooth', 'root_remnant', 'cyst_or_other_lesion', 'anatomy_lookalike', 'other'] },
          tooth: { type: 'string' },
          depth: { type: 'string', enum: ['not_applicable', 'enamel', 'outer_dentin', 'middle_dentin', 'inner_dentin', 'pulp'] },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          box: {
            type: 'object', additionalProperties: false, required: ['x0', 'y0', 'x1', 'y1'],
            properties: { x0: { type: 'number' }, y0: { type: 'number' }, x1: { type: 'number' }, y1: { type: 'number' } },
          },
          note: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
};

const DEPTH = { enamel: 'enamel', outer_dentin: 'outer third of dentin', middle_dentin: 'middle third of dentin', inner_dentin: 'inner third of dentin', pulp: 'reaches the pulp' };
const CAT = {
  caries: 'Decay', secondary_caries: 'Decay next to a filling', filling: 'Filling', crown: 'Crown', root_canal_filling: 'Root canal filling',
  implant: 'Implant', periapical_lesion: 'Dark area at a root tip', bone_loss: 'Bone loss', calculus: 'Calculus (tartar)',
  impacted_tooth: 'Impacted tooth', missing_tooth: 'Missing tooth', root_remnant: 'Root remnant', cyst_or_other_lesion: 'Cyst or other lesion',
  anatomy_lookalike: 'Normal anatomy that can look like disease', other: 'Other',
};
const esc = (t) => String(t).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]);

// the key: kept on this device only if asked
try { const k = localStorage.getItem(KEY_STORE); if (k) { $('#ai-key').value = k; $('#ai-remember').checked = true; } } catch (e) {}
function saveKey() {
  try {
    if ($('#ai-remember').checked && $('#ai-key').value.trim()) localStorage.setItem(KEY_STORE, $('#ai-key').value.trim());
    else localStorage.removeItem(KEY_STORE);
  } catch (e) {}
}
$('#ai-remember').onchange = saveKey;
$('#ai-key').onchange = saveKey;

let running = null;
function status(t) { $('#ai-status').textContent = t; }
$('#ai-stop').onclick = () => { if (running) running.abort(); };

$('#ai-run').onclick = async () => {
  const key = $('#ai-key').value.trim();
  if (!key) { status('Enter your Anthropic API key first. You can create one in the Claude Console.'); $('#ai-key').focus(); return; }
  const img = window.CDC && window.CDC.aiImage();
  if (!img) { status('Add an image first.'); return; }
  saveKey();
  $('#ai-out').innerHTML = '';
  $('#ai-run').disabled = true; $('#ai-stop').hidden = false;
  status('Sending the image to Claude… this usually takes under a minute.');
  const ctrl = new AbortController();
  running = ctrl;
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('./vendor/anthropic-sdk-1.8.0.mjs'));
  } catch (e) {
    status('The AI part of the page could not be loaded. Check the connection and try again.');
    $('#ai-run').disabled = false; $('#ai-stop').hidden = true; running = null;
    return;
  }
  try {
    // the key goes straight from this browser to Anthropic; there is no server in between
    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // if the model declines, the API retries on a fallback model in the same call
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.data } },
          { type: 'text', text: `The app on the device read this image as: ${img.what || 'a dental image'}. List what you see on it.` },
        ],
      }],
    }, { signal: ctrl.signal });
    stream.on('text', () => status('Claude is writing its answer…'));
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') { status('Claude declined to review this image.'); return; }
    if (msg.stop_reason === 'max_tokens') { status('The answer was cut off before it finished. Try again.'); return; }
    const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
    let data;
    try { data = JSON.parse(text); } catch (e) { status('The answer could not be read. Try again.'); return; }
    show(data, msg.model);
  } catch (err) {
    if (err instanceof Anthropic.APIUserAbortError || ctrl.signal.aborted) status('Stopped.');
    else if (err instanceof Anthropic.AuthenticationError) status('The API key was not accepted. Check it and try again.');
    else if (err instanceof Anthropic.PermissionDeniedError) status('This API key is not allowed to use this model.');
    else if (err instanceof Anthropic.RateLimitError) status('Too many requests for this key right now. Wait a minute and try again.');
    else if (err instanceof Anthropic.BadRequestError) status('The request was refused: ' + (err.message || 'bad request') + '.');
    else if (err instanceof Anthropic.APIConnectionError) status('Could not reach Anthropic. Check the internet connection.');
    else if (err instanceof Anthropic.APIError) status(`Anthropic returned an error (${err.status || 'unknown'}). Try again later.`);
    else status('Something went wrong: ' + (err && err.message || err));
  } finally {
    $('#ai-run').disabled = false; $('#ai-stop').hidden = true; running = null;
  }
};

function show(data, model) {
  const list = Array.isArray(data.findings) ? data.findings : [];
  window.CDC.aiShow(list);
  const items = list.map((f, i) => {
    const bits = [f.tooth ? 'Tooth ' + f.tooth : '', DEPTH[f.depth] || '', f.confidence ? f.confidence + ' confidence' : ''].filter(Boolean).join(' · ');
    return `<li><span class="ainum">${i + 1}</span><div><b>${esc(f.label || CAT[f.category] || 'Finding')}</b>${bits ? `<span class="aimeta">${esc(bits)}</span>` : ''}${f.note ? `<span>${esc(f.note)}</span>` : ''}</div></li>`;
  }).join('');
  $('#ai-out').innerHTML = `
    <div class="airesult">
      <p><b>Summary.</b> ${esc(data.summary || '')}</p>
      ${data.image_quality ? `<p><b>Image quality.</b> ${esc(data.image_quality)}</p>` : ''}
      ${items ? `<ol class="ailist">${items}</ol>` : '<p>No findings listed.</p>'}
      <p class="hint">From ${esc(model || MODEL)}. Boxes on the image are numbered to match and are approximate. An AI reading can be wrong in both directions; it is not a diagnosis.</p>
    </div>`;
  status(list.length ? `${list.length} ${list.length === 1 ? 'finding' : 'findings'} listed and marked on the image.` : 'Done.');
}
