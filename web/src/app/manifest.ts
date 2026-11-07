import type { MetadataRoute } from "next";

/** Web app manifest: makes BrandPilot installable and is the source for the Android TWA (Bubblewrap). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "BrandPilot — AI marketing team",
    short_name: "BrandPilot",
    description: "A brand-aware AI social media marketing manager: strategy, creatives, copy, campaigns, calendar and analytics.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f8f7f4",
    theme_color: "#1b1a17",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Content Calendar", url: "/calendar", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Creative Studio", url: "/creative-studio", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
