# Caries Depth Checker

A website that checks dental X-rays and tooth photos for decay and how deep it goes: sound, enamel, dentin or pulp, on the ICCMS RA1 to RC6 scale. It works on a phone or a computer, and the image never leaves the device unless you ask for the optional AI second opinion.

It reads:

- **Panoramic X-rays (OPG).** Shows the bite line, metal fillings, crowns, root fillings and implants, and checks how the head was positioned. Tap a tooth to check it: it is numbered (FDI), cut out, turned crown-up if it is an upper tooth, and read. A tooth chart keeps the teeth checked.
- **Bite-wing X-rays.** The same, for premolars and molars.
- **Single-tooth X-rays** and **photos of a tooth cut in half.** A reference molar, premolar or front tooth is lined up with the tooth, dark (radiolucent) areas are marked and can be corrected with a brush, and the depth is read.
- **The shaded molar diagram** from the Caries depth dataset (Diagram mode), and **Draw** mode for shading a lesion yourself.

> A teaching aid, not a diagnostic device. The X-ray readings have only been tested on simulated images, not on labelled real radiographs (results below). Treatment decisions need a dentist's clinical examination.

## Adding an image

- **Take a photo** (opens the camera on a phone), **Choose a file**, drag an image onto the page, or paste one.
- Installed as an app on Android, it appears in the phone's **Share** menu: share an X-ray from the gallery straight into it.
- The image type is detected (diagram, panoramic, bite-wing, single tooth, cut-tooth photo) and can be changed.
- **Adjust image** crops, turns, mirrors, inverts and boosts the contrast. That's useful for photos of an X-ray on a screen or light box.
- **Share result** sends an annotated picture through the phone's share sheet, or downloads it.

## What it checks

On each tooth:
- how deep the dark area goes;
- which surface it is on (biting, side, neck), with what that means for how visible it is;
- cervical burn-out;
- fillings, crowns and root fillings, and dark areas against a filling (possible secondary decay);
- dark areas at the root tips;
- image quality: contrast, exposure, a tooth that had to be stretched to fit.

On a whole panoramic or bite-wing image:
- the bite line;
- metal objects;
- head positioning (from the curve and tilt of the bite line).

The rules come from F. A. Pasler, *Color Atlas of Dental Medicine: Radiology* (Thieme). The page summarises them in its own words, with a **Learn** section on:
- which X-ray shows what;
- how panoramic X-rays distort;
- positioning mistakes;
- normal anatomy that looks like disease;
- lesions and cysts at the root tips;
- calcifications;
- unusual teeth;
- the sinus;
- how to photograph an X-ray with a phone.

### Optional AI second opinion

The **AI second opinion** panel sends the image on screen to Claude (`claude-opus-5-5`) using the person's **own Anthropic API key**, and lists what it sees as numbered, boxed findings:
- decay and its depth;
- fillings, crowns, root fillings and implants;
- bone loss;
- lesions at the root tips;
- impacted or missing teeth;
- calculus;
- anatomy that can look like disease.

How it works:
- **Request.** It uses the official Anthropic TypeScript SDK (1.8.0, bundled into `js/vendor/`, Apache-2.0) with structured output and the server-side refusal fallback (`fallbacks: "default"`). The SDK is loaded only when the button is pressed.
- **Key.** The key goes straight from the browser to Anthropic; there is no server. It is kept in the browser's local storage only if "Remember the key" is ticked.
- **Testing.** Tested against a mocked API (request shape, streamed answer, boxes drawn, rejected key), not against the live API.

## Run it

It is a static site with no build step. Serve the folder with any web server:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

The background threads, the offline cache, "Install as app" and "Share to" need it served over `http://localhost` or `https://`. Opened straight from disk, it falls back to running everything on the page.

## Put it online

Any static host works. With GitHub Pages:
1. In the repository, open **Settings → Pages → Build and deployment**.
2. Choose **Deploy from a branch**, pick the branch and `/ (root)`.
3. The site appears at `https://<user>.github.io/<repo>/`.

Netlify, Vercel and Cloudflare Pages also work with no build step. Camera, share-to and install need `https`, which these hosts provide.

## How it works

**Diagram photos.**
- The engine registers the photo to the reference diagram, separates the shading from the printed lines, and measures how deep the shading reaches.
- Each point has a depth index: 0 at the surface, 1 at the enamel–dentin junction, 2 at the pulp.
- Two thresholds were fitted to the labelled dataset: past 1.29 is dentin caries, and touching the pulp outline is pulp involvement.
- The original analysis reports 77/77 labelled photos correct (75/77 leave-one-out). The 5 labelled samples in this repo all read correctly.

**Single-tooth X-rays.**
- Three reference teeth (molar, premolar, front tooth) are fitted to tooth-shaped blobs by silhouette ICP. Auto mode tries all three in parallel on background threads, and you can place the tooth by hand and snap it.
- Dark patches are found by comparing each point of the crown with the sound enamel and dentin around it. Air-dark slivers along the outline, burn-out at both sides of the neck, and metal are kept out.
- The marked area is read with the same depth index and thresholds as the diagram.

**Whole X-rays.**
- **Bite line:** a smooth path through the dark gap between the crowns, found by dynamic programming.
- **Metal:** flat, saturated white objects, sorted by position and shape.
- **Tooth numbers:** the gaps between crowns along the arch, fitted to a table of average crown widths.
- **A tapped tooth:** it is cut out along the bite line's slope and measured (the gaps either side, the biting edge). A crown outline is then snapped to it by the contrast across its edge: bright enamel inside, dark gap outside.
- **Its decay search:** carries over the whole image's metal map, leaves out the neck band, and drops matched pairs of side patches (outline mismatch, not decay).

## Test results (simulated images)

| Test | Result |
|---|---|
| Diagram samples (5 labelled + 3 testers) | 8/8 as expected |
| Single-tooth X-rays: 4 examples + 7 premolar/front/molar cases + 9 atlas cases | all correct |
| Harder single-tooth variants (tilted, small, noisy, upside-down, low contrast) | 10/16 automatic, 8/8 after a rough manual placement |
| Panoramic: image type, bite line, metal objects (4 fillings/crowns, 1 root filling, 1 implant) | all found |
| Panoramic: tooth numbers from a tap | 31/31 |
| Panoramic: per-tooth reading | 23/31 (2 of 3 lesions found; the missed one is a tiny enamel lesion; 6 false alarms on 28 sound teeth) |
| Bite-wing: teeth located and numbered by position | 8/8 |
| Bite-wing: per-tooth reading | 2/8 (weak; check every marking) |
| Phone and desktop: whole flow, editor, share, AI panel (mocked), offline | no errors, no sideways scrolling |

The simulated images are built from the reference teeth themselves. Real radiographs are blurrier, noisier and more varied, so expect lower numbers on them.

## Files

| Path | What it is |
| --- | --- |
| `index.html` | The page |
| `css/app.css` | Styles (light and dark) |
| `js/engine.js` | Detection engine: diagram registration, template fitting, dark-area search, checks |
| `js/templates.js` | Reference teeth: the dataset's molar, plus a premolar and a front tooth |
| `js/scan.js` | Whole-image analysis: image type, bite line, metal, positioning, tooth numbering |
| `js/app.js`, `js/xray.js`, `js/whole.js`, `js/upload.js`, `js/app-start.js` | The page's views and controls |
| `js/ai.js`, `js/vendor/` | Optional AI second opinion and the bundled Anthropic SDK |
| `js/worker.js`, `js/analysis.js` | Background threads |
| `samples/` | Diagram photos from the dataset and simulated X-rays |
| `manifest.webmanifest`, `sw.js`, `icons/` | Install as app, share target, offline cache |

When you add or rename files in `samples/` or `js/`, update the lists in `sw.js` and bump `CACHE` there, so returning visitors get the new files.
