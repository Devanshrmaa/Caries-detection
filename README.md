# Caries Depth Checker

A website that reads how deep a caries lesion goes (sound, enamel, dentin or pulp, on the ICCMS RA1 to RC6 scale) from:

- **Diagram**: a photo of the shaded molar diagram from the Caries depth dataset (normal, enamel, dentin and pulp folders).
- **X-ray**: a dental radiograph or a photo of a tooth cut in half. You line the tooth up with the reference molar, the app marks dark (radiolucent) areas that open onto the tooth surface, and you can correct them with a brush.
- **Draw**: shade a lesion on the reference molar yourself.

Everything runs in the browser. Photos never leave the device, there is no server, and the site works offline once it has been opened.

> A teaching aid, not a diagnostic device. X-ray mode maps a dark area onto one reference molar and has not been validated on labelled radiographs. Treatment decisions need a dentist's clinical examination.

## Run it

It is a static site: `index.html` plus a few files. Serve the folder with any web server, for example:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` straight from disk mostly works, but the example images, the offline cache and "Install as app" need it served over `http://localhost` or `https://`.

## Put it online

Any static host works. With GitHub Pages: **Settings → Pages → Build and deployment → Deploy from a branch**, pick the branch and `/ (root)`, and the site appears at `https://<user>.github.io/<repo>/`. Netlify, Vercel and Cloudflare Pages also work with no build step.

## How it reads an image

**Diagram photos.** The engine finds the dark tooth outline, registers it to the reference diagram (moments, silhouette ICP, outline ICP, then a perspective correction from the printed lines), separates the shading from the printed lines, and measures how deep the shading reaches. Each point inside the tooth has a depth index: 0 at the surface, 1 at the enamel–dentin junction, 2 at the pulp. Two thresholds were fitted to the labelled dataset. Shading past 1.29 counts as dentin caries, and shading that touches the pulp outline counts as pulp involvement. The original analysis reports all 77 unique labelled photos reading correctly (75/77 leave-one-out). The 5 labelled samples in this repo all read correctly.

**X-rays and cut teeth.**

1. *Auto-fit*: the image is cut at a few grey levels, since on a radiograph air < bone < dentin < enamel. The reference molar is then fitted to tooth-shaped blobs with silhouette ICP. It tries either way up and either way round, with upright and tilted starts. A tooth near the middle wins over one at the edge. When the image has been placed by hand, Auto-fit snaps to the tooth under that placement instead.
2. *Find dark areas*: each point of the crown is compared with the sound enamel and dentin around it. Dark patches that open onto the tooth surface are kept. Air-dark slivers along the outline, which a slightly-off fit leaves behind, are dropped.
3. *Read the depth*: the marked area goes through the same depth index and thresholds as the diagram.

On simulated radiographs built from the reference molar (in `samples/xray-*.jpg`), all four examples read correctly. On 16 harder simulated variants (tilted, upside-down, small, noisy, low-contrast, with touching neighbours), 10 read correctly fully automatically. The other 6 had several teeth in view, and auto-fit picked a neighbour or asked for help. All 16 read correctly after a rough manual placement and Auto-fit. A real radiograph of a differently shaped tooth only fits the reference roughly, and overlapping teeth, fillings, cervical burn-out and pulp horns can look like decay. That is why the marked area can be edited.

If someone picks an X-ray in Diagram mode, it opens in X-ray mode. A photo of the printed diagram picked in X-ray mode opens in Diagram mode.

## Files

| Path | What it is |
| --- | --- |
| `index.html` | The whole app: page, styles, the detection engine (`#engine-js`, also run in a Web Worker) and the UI |
| `samples/` | Dataset photos of the diagram, and simulated X-rays for X-ray mode |
| `manifest.webmanifest`, `sw.js`, `icons/` | Install-as-app support and the offline cache |

When you add or rename files in `samples/`, update the list in `sw.js` and bump `CACHE` there so returning visitors get the new files.
