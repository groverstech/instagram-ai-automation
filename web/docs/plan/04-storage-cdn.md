# 4. Storage and CDN: Cloudflare R2 implementation plan

**Decision:**
- Cloudflare R2 with CDN delivery.
- An S3-compatible adapter.
- Private by default, with signed URLs.
- Image and video optimisation.
- Tenant isolation and lifecycle management.
- Provider-independent, so the files can move to AWS S3.

## 4.1 Today

- Local disk only. `StorageProvider { put, get, remove }` lives in `src/server/storage/index.ts`.
- Assets and creatives are served through authenticated Next.js routes, and every creative
  request is rendered on the fly.
- Media for publishing comes from a signed, expiring app route that also renders on every fetch.

## 4.2 Design

```
              ┌────────────── StorageProvider (interface) ──────────────┐
              │ put · get · head · remove · list(prefix) · copy          │
              │ presignGet(key, ttl, disposition?) · presignPut(key, …)  │
              │ publicUrl(key)  (only for keys in the public namespace)  │
              └────────┬───────────────────────┬────────────────────────┘
                       │                       │
               S3Compatible (AWS SDK v3)    LocalDisk (dev, tests)
               ├─ R2  (endpoint = <account>.r2.cloudflarestorage.com)
               └─ AWS S3 (no endpoint override) → migration path
```

- **One adapter for R2 and S3:** the AWS SDK v3 S3 client. Only the endpoint and credentials
  differ, so a later move to S3 means copying objects and changing configuration, with no code
  change.
- **Two buckets:**
  - `bp-private`, which is everything. No public access. Reads go through short-lived signed
    URLs, or through the app.
  - `bp-delivery`: published media and render-cache derivatives, served from a custom domain on
    Cloudflare's CDN. It holds no originals.

  Social platforms fetch from `bp-delivery` URLs with unguessable keys and a lifecycle expiry.
- **Configuration only:**
  - `STORAGE_DRIVER` (`local` or `s3`), `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET_PRIVATE`,
    `S3_BUCKET_DELIVERY`, `CDN_BASE_URL`;
  - credentials as secrets (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`), scoped to these buckets
    only.

## 4.3 Tenant-isolated key layout (fixes defect D7)

```
org/<orgId>/brand/<brandId>/assets/<assetId>/original.<ext>
org/<orgId>/brand/<brandId>/assets/<assetId>/w1024.webp          (derivatives)
org/<orgId>/brand/<brandId>/creatives/<creativeId>/visual-<hash>.<ext>
org/<orgId>/brand/<brandId>/renders/<creativeId>/<contentHash>/<format>-s<slide>.png
org/<orgId>/brand/<brandId>/publish/<postId>/<attempt>/<n>.jpg   (delivery bucket)
org/<orgId>/exports/<exportId>.zip
```

- **Keys are built only server-side** from database IDs that have been authorisation-checked. A
  client never supplies a key.
- **Every read checks the key prefix** against the caller's organisation and brand, as defence in
  depth on top of the database checks.
- **Per-tenant operations become prefix operations:** usage (bytes per organisation and brand),
  export, deletion on cancellation, and lifecycle.

## 4.4 Uploads and downloads

- **Uploads (presigned PUT):**
  1. The client asks the app for an upload.
  2. The app checks role, quota, MIME type and declared size, and returns a presigned PUT to a
     `pending/` key with the content type and a length limit.
  3. The client uploads directly to R2.
  4. The client calls `complete`.
  5. The server `head`s the object, verifies its magic bytes and size, scans it (images are
     decoded with sharp; documents are type-checked), then moves it to its final key and records
     it.

  Uploads that are never completed expire from `pending/` after 24 hours (lifecycle rule).
- **Downloads:** short-lived (about 5 minute) presigned GETs with `Content-Disposition` for
  attachments. In-app previews go through the CDN for delivery keys, or presigned GETs for
  private keys.
- **Limits:** per-plan storage quota (configurable, document 5); maximum file size per type; a
  MIME allow-list (no SVG execution; SVGs are sanitised or rasterised).

## 4.5 Image optimisation and the render cache (fixes defect D6)

- **Render cache:**
  - The cache key is a hash of the creative's content (concept, slides, palette, style, logo,
    visual key, brand fonts and colours, renderer version) plus the format and slide.
  - On a miss, the server renders, stores the result under `renders/…/<hash>/…` and returns it.
  - On a hit, it returns a CDN or presigned URL, so nothing is rendered.
  - Any edit changes the hash, so the cache never needs invalidating. Old renders expire through
    lifecycle rules.
- **Publish derivatives:** media profiles per platform (document 2):
  - JPEG (sRGB) at quality 90 for Instagram;
  - the right aspect ratio and size per placement;
  - written to the delivery bucket at publish time, with a URL valid for the platform's fetch
    window.
- **Asset derivatives:** WebP or AVIF thumbnails at several widths, generated with sharp on upload,
  for the UI. Cloudflare Image Transformations can replace this later as a configuration choice.

## 4.6 Video

- Video originals are uploaded through **multipart presigned upload**.
- Processing runs in a worker: probe → transcode to platform profiles (H.264/AAC MP4; vertical
  9:16 for Reels, Shorts and TikTok) → poster frames → store derivatives.
- **Options:**
  1. FFmpeg in our own workers. Cheapest per minute, more operations work.
  2. A managed video service (e.g. Cloudflare Stream) for transcoding and delivery. Simpler,
     priced per minute stored and delivered.

  Decide in P4-8 with real volumes. The adapter keeps the choice swappable.

## 4.7 Lifecycle and storage management

| Prefix | Rule |
|---|---|
| `pending/` | Delete after 24 h |
| `renders/` | Delete 30 days after last write (re-rendered on demand) |
| `publish/` (delivery) | Delete 14 days after the publish is confirmed |
| `exports/` | Delete after 7 days |
| Originals (`assets/`, `creatives/…/visual-*`) | Kept while the record exists. Replaced visuals are deleted after the new one is saved (already done in PR #6). |
| Cancelled organisation | Soft-deleted for 30 days (restorable), then a prefix purge plus a database purge, with an audit record |

- A nightly job computes bytes per organisation and brand for quotas and the admin dashboard, and
  reconciles database records against objects: orphans are deleted, missing objects raise alerts.

## 4.8 Security

- Buckets are private. The delivery bucket is reachable only through the CDN custom domain, and
  bucket listing is disabled.
- R2 API tokens are scoped to the two buckets, with object read and write only. They live in the
  secret store and are rotated.
- Presigned URLs are short-lived and bound to one key and content type. Upload limits are enforced
  by checking with `head` before the upload is accepted.
- `X-Content-Type-Options: nosniff` and correct `Content-Type` on all responses. User files are
  never served as HTML.
- Access is logged per tenant: downloads of private assets go through an audited signing endpoint.

## 4.9 Migration from local disk

1. Deploy the adapter with `STORAGE_DRIVER=local` (no behaviour change).
2. Run a migration job that copies each file to its new tenant key in R2 and records the new key,
   in batches that can be resumed.
3. Switch to `STORAGE_DRIVER=s3`; keep reading local disk as a fallback for one release.
4. Verify every key is reachable, then remove the local files.

## 4.10 Tests

- The adapter contract test runs against LocalDisk, and against R2 or MinIO in a dedicated job.
- Tenant-prefix enforcement: another organisation's key is refused even with a valid database ID.
- Presigned upload: wrong type, wrong size and wrong magic bytes are rejected; expired pending
  uploads are cleaned up.
- Render cache: an edit gives a new hash; an unchanged creative is not re-rendered (render counter).
- Publish derivative: the Instagram media is JPEG at the correct size.
- Lifecycle and reconciliation jobs, run against fixtures.
