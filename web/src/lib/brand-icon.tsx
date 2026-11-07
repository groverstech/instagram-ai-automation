// App icon artwork, rendered with next/og. Used for the PWA manifest, favicon and Android TWA.
const SPARKLE =
  "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z";

/**
 * @param size   output size in px
 * @param maskable full-bleed background with the glyph inside Android's 80% safe zone
 */
export function BrandIcon({ size, maskable = false }: { size: number; maskable?: boolean }) {
  const glyph = Math.round(size * (maskable ? 0.42 : 0.56));
  return (
    <div
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #2a2824 0%, #1b1a17 60%, #2b2547 100%)",
        borderRadius: maskable ? 0 : Math.round(size * 0.22),
      }}
    >
      <svg width={glyph} height={glyph} viewBox="0 0 24 24">
        <path d={SPARKLE} fill="#ffffff" />
        <circle cx="20" cy="4.5" r="1.6" fill="#c9bff7" />
        <circle cx="4.5" cy="19.5" r="1.2" fill="#f6c8b0" />
      </svg>
    </div>
  );
}
