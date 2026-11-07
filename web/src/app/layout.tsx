import type { Metadata, Viewport } from "next";
import { Inter, Instrument_Serif } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const display = Instrument_Serif({ subsets: ["latin"], weight: "400", variable: "--font-display" });

export const viewport: Viewport = {
  themeColor: "#1b1a17",
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  applicationName: "BrandPilot",
  appleWebApp: { capable: true, title: "BrandPilot", statusBarStyle: "default" },
  title: "BrandPilot — your AI marketing team",
  description: "A brand-aware AI social media marketing manager: strategy, creatives, copy, campaigns, calendar and analytics.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable}`}>
      <body className="min-h-screen font-sans text-[14px] leading-relaxed">{children}</body>
    </html>
  );
}
