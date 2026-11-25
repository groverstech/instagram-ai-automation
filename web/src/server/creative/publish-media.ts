import "server-only";

/**
 * Media that social platforms download when publishing (plan defect D1). Instagram's content
 * publishing API accepts JPEG images only, so published media is served as baseline sRGB JPEG:
 * transparency flattened onto white, the sRGB profile embedded, full-resolution chroma so brand
 * text and logos stay sharp.
 */
export async function toPublishJpeg(png: Buffer): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(png).flatten({ background: "#ffffff" }).toColourspace("srgb").withIccProfile("srgb").jpeg({ quality: 90, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer();
}
