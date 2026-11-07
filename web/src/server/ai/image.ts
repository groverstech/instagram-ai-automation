import "server-only";

export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024";

export interface ImageProvider {
  readonly name: string;
  generate(prompt: string, size: ImageSize): Promise<{ data: Buffer; mime: string }>;
}

export class ImageProviderUnavailable extends Error {}

const openaiImages: ImageProvider = {
  name: "openai:gpt-image-1",
  async generate(prompt, size) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new ImageProviderUnavailable("OPENAI_API_KEY is not set.");
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "gpt-image-1", prompt, size, quality: "high", n: 1 }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Image generation failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { data: { b64_json: string }[] };
    return { data: Buffer.from(json.data[0].b64_json, "base64"), mime: "image/png" };
  },
};

export function imageProvider(): ImageProvider | null {
  const p = (process.env.IMAGE_PROVIDER ?? "openai").toLowerCase();
  if (p === "none") return null;
  if (p === "openai") return process.env.OPENAI_API_KEY ? openaiImages : null;
  return null;
}

export function imageStatus() {
  const p = imageProvider();
  return { ready: Boolean(p), provider: p?.name ?? "none" };
}
