import { ImageResponse } from "next/og";
import { BrandIcon } from "@/lib/brand-icon";

const ICONS: Record<string, { size: number; maskable?: boolean }> = {
  "icon-192.png": { size: 192 },
  "icon-512.png": { size: 512 },
  "maskable-192.png": { size: 192, maskable: true },
  "maskable-512.png": { size: 512, maskable: true },
};

export const dynamic = "force-static";
export function generateStaticParams() {
  return Object.keys(ICONS).map((file) => ({ file }));
}

export async function GET(_: Request, { params }: { params: Promise<{ file: string }> }) {
  const icon = ICONS[(await params).file];
  if (!icon) return new Response("Not found", { status: 404 });
  return new ImageResponse(<BrandIcon size={icon.size} maskable={icon.maskable} />, {
    width: icon.size,
    height: icon.size,
    headers: { "cache-control": "public, max-age=604800, immutable" },
  });
}
