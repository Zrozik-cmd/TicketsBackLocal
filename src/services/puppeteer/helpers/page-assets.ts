/*
 * Functions run INSIDE the rendered page through `page.evaluate(fn, arg)`: Puppeteer sends
 * their source text, so they must stay self-contained (no imports, no outer variables).
 */

/**
 * The page is ready to capture: fonts loaded and every image decoded. The HTML carries its
 * images as `data:` URLs, so this never waits for the network; a broken image is skipped.
 */
export async function waitForPageAssets(): Promise<void> {
  await document.fonts.ready;
  await Promise.all(Array.from(document.images, (img) => img.decode().catch(() => undefined)));
}

export type ShrinkImagesOptions = {
  /** Largest number of image pixels per CSS pixel the image is displayed at. */
  scale: number;
  /** JPEG quality (0-1) of the re-encoded opaque images. */
  jpegQuality: number;
};

/**
 * Before `page.pdf()`: Chrome embeds each image in the PDF at its full source resolution (a
 * JPEG byte for byte, anything else as lossless pixels), so a 2400px cover or a 400px PNG logo
 * shown at 120px weighs the same as the original file, and a WebP / AVIF / GIF far more. Each
 * `img[data-pdf-shrink]` holding a raster `data:` URL (any type but SVG, which stays vector) is
 * redrawn at no more than `scale` times its displayed size (never enlarged) and replaced by a
 * JPEG, or by a PNG when it has transparency; a small opaque image takes the smaller of the
 * two, so flat logos stay lossless. An image on an opaque CSS background (the sponsor logos) is
 * flattened onto that colour first, which is what the page shows anyway. A JPEG or PNG original
 * stays when re-encoding saves too little. Only for images sized by CSS: the swap must not
 * change the layout. The QR code is not marked and stays lossless.
 * Returns how many images were replaced.
 */
export async function shrinkImagesForPdf(options: ShrinkImagesOptions): Promise<number> {
  let replaced = 0;
  const images = Array.from(document.querySelectorAll<HTMLImageElement>('img[data-pdf-shrink]'));
  for (const img of images) {
    try {
      const src = img.currentSrc || img.src;
      const raster = /^data:/i.test(src) && !/^data:image\/svg\+xml[;,]/i.test(src);
      if (!img.complete || !img.naturalWidth || !raster) continue;
      const box = img.getBoundingClientRect();
      const k = Math.min(
        1,
        Math.max((box.width * options.scale) / img.naturalWidth, (box.height * options.scale) / img.naturalHeight),
      );
      const width = Math.max(1, Math.round(img.naturalWidth * k));
      const height = Math.max(1, Math.round(img.naturalHeight * k));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      const background = getComputedStyle(img).backgroundColor;
      const opaqueBackground = /^rgb\(/.test(background);
      if (opaqueBackground) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
      }
      ctx.drawImage(img, 0, 0, width, height);

      let transparent = false;
      if (!opaqueBackground) {
        const pixels = ctx.getImageData(0, 0, width, height).data;
        for (let i = 3; i < pixels.length && !transparent; i += 4) transparent = pixels[i] < 255;
      }
      const candidates = transparent
        ? [canvas.toDataURL('image/png')]
        : [canvas.toDataURL('image/jpeg', options.jpegQuality)];
      if (!transparent && width * height <= 512 * 512) candidates.push(canvas.toDataURL('image/png'));
      const best = candidates.reduce((a, b) => (b.length < a.length ? b : a));
      // Only a JPEG or PNG original (told by its bytes: the media type may be wrong) weighs in
      // the PDF about what its file does; any other format is always replaced.
      const comma = src.indexOf(',');
      const keepable = /^(\/9j\/|iVBORw0KGgo)/.test(src.slice(comma + 1, comma + 12));
      // Not downscaled: a re-encode that saves under 10 % only adds a generation of JPEG loss.
      if (keepable && best.length >= (k < 1 ? src.length : src.length * 0.9)) continue;

      img.src = best;
      await img.decode();
      replaced++;
    } catch {
      // This image keeps its original bytes.
    }
  }
  return replaced;
}
