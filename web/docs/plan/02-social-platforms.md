# 2. Social platform integration and app-approval roadmap

**Order (approved):** Instagram → Facebook → LinkedIn → YouTube. TikTok and X come later.

**Start the registrations and reviews now.** They take weeks, and several need the app-review
prerequisites (P4-0a) to be live first.

> **Verify at submission time.** Platform permissions, limits and review rules change often. The
> details below reflect the platforms' documented behaviour as understood when this was written
> (Nov 2026). Each item marked *(verify)* must be re-checked against the official developer docs
> while preparing the submission. The code also reads limits at runtime where the platform
> exposes them, for example Instagram's publishing-limit endpoint.

## 2.1 Shared prerequisites (all platforms)

| Item | Needed for | Status |
|---|---|---|
| Production domain with HTTPS, owned and verified (DNS) | All; Google requires domain verification | To do |
| Public **privacy policy** URL (explains which platform data is collected, why, how long it's kept, and how to delete it) | All | **Missing** (defect D4) |
| Public **terms of service** URL | All | **Missing** |
| **Data deletion**: instructions URL, plus a Meta data-deletion request callback | Meta (required); good practice everywhere | **Missing** |
| Meta **deauthorise** callback (a user removes the app) | Meta | **Missing** |
| App icon (1024×1024) and brand name consistent with the domain | All | To do |
| Business verification documents (legal entity name, address, registration, phone) | Meta, LinkedIn, Google | Owner action |
| Reviewer test account with demo brand and data; test social accounts on every platform | All reviews | To do |
| Screencasts of each permission in use (scripts in §2.7) | Meta, Google, LinkedIn | To do after P4-0a |
| OAuth redirect URIs for production and staging | All | Code exists: `/api/oauth/<platform>/callback` |

## 2.2 Instagram (priority 1)

**Integration path.** Use the Instagram API with **Facebook Login for Business**, as the current
code does. One Meta app serves Instagram and Facebook Pages.

There is an alternative, the Instagram API with **Instagram Login**, which doesn't need a linked
Facebook Page. It can be added later as a second login option through the same provider
interface.

**Account requirements:** an Instagram **Business or Creator** account linked to a Facebook Page
that the connecting user manages.

| Permission (Facebook Login path) | Used for | Review |
|---|---|---|
| `instagram_basic` | Read the profile and media | Advanced Access |
| `instagram_content_publish` | Publish images, carousels, Reels and Stories | Advanced Access |
| `instagram_manage_insights` | Post and account insights | Advanced Access |
| `instagram_manage_comments` *(later: engagement features)* | Read and reply to comments | Advanced Access |
| `pages_show_list`, `pages_read_engagement` | Find the Pages and the linked Instagram account | Advanced Access |
| `business_management` | Accounts owned through Business Manager | Advanced Access |

**OAuth flow:**
1. Facebook Login (authorisation code) returns a short-lived user token.
2. Server-side exchange for a long-lived token, about 60 days *(verify)*.
3. `GET /me/accounts` returns the Pages and their Page tokens.
4. `GET /{page-id}?fields=instagram_business_account` returns the Instagram user ID.
5. Tokens are stored encrypted, already in place. Expiry is tracked so the user can be prompted to
   reconnect before the token lapses.

**Publishing flow:**
1. `POST /{ig-user-id}/media` creates a container (`image_url`, or `video_url` with
   `media_type=REELS|STORIES`, or `CAROUSEL` with children).
2. Poll `status_code` until it is `FINISHED`.
3. `POST /{ig-user-id}/media_publish`.

**Limitations to design for:**
- **Images must be JPEG** (defect D1). Feed aspect ratio about 4:5 to 1.91:1 *(verify)*. Story and
  Reel video specs *(verify)*.
- Media is fetched by Meta from a **public URL**: a CDN or signed URL with an expiry long enough
  for the fetch.
- **Publishing cap per account** over a rolling 24 hours. Read it from
  `GET /{ig-user-id}/content_publishing_limit` before scheduling, rather than hardcoding it.
- Carousels: a limited number of children *(verify the current maximum)*; all children are created
  first.
- Business Use Case rate limits apply per app and account. Read the `X-Business-Use-Case-Usage`
  headers and back off.
- Insight metrics change between Graph API versions. Pin `META_GRAPH_VERSION` (already done) and
  plan a version upgrade every 6–12 months.
- No native scheduling for Instagram: BrandPilot's scheduler publishes at the scheduled time.

**Review requirements:**
- Business verification.
- Advanced Access for each permission, with a screencast and written use case per permission.
- App in Live mode.
- **Access Verification / Tech Provider** status, because BrandPilot acts for other businesses
  *(verify the current name of this programme)*.

## 2.3 Facebook Pages (priority 2), the same Meta app

| Permission | Used for |
|---|---|
| `pages_manage_posts` | Create, edit and delete Page posts |
| `pages_read_engagement` | Read Page content and engagement |
| `pages_show_list` | List the user's Pages |
| `read_insights` | Page and post insights |
| `pages_manage_engagement` *(later)* | Comments and replies |

**Publishing:**
- **Photo:** `POST /{page-id}/photos` (`url`, `caption`).
- **Multi-photo post:** upload unpublished photos, then post with `attached_media`.
- **Video and Reels:** resumable video upload endpoints.
- **Native scheduling:** `published=false` plus `scheduled_publish_time` is available. BrandPilot
  still uses its own scheduler, so all platforms behave the same and approvals stay in one place.

**Limitations:**
- Personal profiles can't be posted to through the API; only Pages.
- The same Business Use Case rate limits as Instagram.
- Page tokens are derived from the long-lived user token.

**Review:** the same submission as Instagram (one Meta app), with screencasts for the Page
permissions.

## 2.4 LinkedIn (priority 3)

| Product (LinkedIn developer portal) | Scopes | Access |
|---|---|---|
| Sign In with LinkedIn using OpenID Connect | `openid`, `profile`, `email` | Self-serve |
| Share on LinkedIn | `w_member_social` (post as a member) | Self-serve; **this is what the code uses today** |
| **Community Management API** | `w_organization_social`, `r_organization_social`, `rw_organization_admin`, `r_organization_admin` | **Application and review.** Development tier first, then a Standard tier upgrade with a demo. Needs a verified LinkedIn Page for the developer's company. Plan for a **dedicated LinkedIn app** for this product, since LinkedIn has required it *(verify)*. |

**OAuth:**
- 3-legged authorisation code flow.
- Access tokens last about 60 days.
- Refresh tokens (about a year) are available only for approved partner apps *(verify)*.
- Plan reconnect prompts accordingly.

**Publishing and analytics:**
- Versioned REST API with a `LinkedIn-Version: YYYYMM` header. Versions are retired on a rolling
  schedule, so pin the version and upgrade on a calendar.
- **Posts:** the Posts API. Images and videos use the Images and Videos upload APIs (register,
  upload, then reference the URN). Multi-image and document posts are supported.
- **Organisation analytics:** share statistics, follower statistics and page statistics endpoints.

**Limitations:**
- Daily rate limits per app and per member, visible in the developer portal.
- No native scheduling through the API: BrandPilot schedules.
- Organisation posting needs the connecting member to be a Page admin. The app verifies this with
  `rw_organization_admin`.

**Code change required:** add organisation scopes and organisation-URN posting (defect D3). Keep
member posting as an option.

## 2.5 YouTube (priority 4)

**Google Cloud setup:**
- Enable the **YouTube Data API v3** and the **YouTube Analytics API**.
- Configure the OAuth consent screen and move it from **Testing to In production**. In Testing,
  refresh tokens expire after about 7 days *(verify)*.

| Scope | Used for | Classification |
|---|---|---|
| `https://www.googleapis.com/auth/youtube.upload` | Upload videos and Shorts | Sensitive |
| `https://www.googleapis.com/auth/youtube.readonly` | Read the channel and videos | Sensitive |
| `https://www.googleapis.com/auth/yt-analytics.readonly` | Analytics | Sensitive |

**Reviews (two separate processes):**
1. **Google OAuth app verification**, for the sensitive scopes. It needs:
   - a verified domain;
   - privacy policy and homepage on that domain;
   - an app name and logo consistent with the brand;
   - a demo video showing each scope in use.

   Sensitive (not restricted) scopes don't need a third-party CASA security assessment
   *(verify)*.
2. **YouTube API Services audit / compliance review.** It's needed for:
   - **public uploads:** videos uploaded by unaudited API projects are locked to private
     *(verify)*;
   - **quota increases:** the default is 10,000 units per day, and an upload costs about 1,600
     units, so only a handful of uploads per day per project before an extension *(verify the
     quota table)*.

**Publishing:**
- `videos.insert` (resumable upload). Shorts are vertical videos within the Shorts length limit
  *(verify the current limit)*; there is no separate Shorts endpoint.
- `thumbnails.set` needs a verified channel.
- Scheduling: upload as private with `status.publishAt`, or let BrandPilot publish at the time.

**Dependency:** video generation and processing (document 4, §4.6). YouTube is video-only, so it
follows the video pipeline.

## 2.6 Later: TikTok and X (same architecture, no redesign)

| Platform | What to plan for |
|---|---|
| TikTok | Content Posting API. Unaudited clients can post only privately and to limited users; an **audit** is required for public posting *(verify)*. Video-first, with direct post or upload-to-inbox flows. PKCE OAuth (code already uses it). |
| X | Paid API access tiers; pricing and limits change often *(verify before committing)*. OAuth 2.0 with PKCE. Media upload, then post. |

**Modular provider architecture.** This extends the existing `src/server/social` interface.

```
PlatformProvider
  id, label
  oauth: authorizeUrl(state, pkce) · exchange(code) · refresh(token) · revoke(token)
  discover(token) → accounts[]                      (pages, channels, org URNs)
  mediaProfiles → { image: {formats, ratios, maxBytes}, video: {codecs, maxSecs, ratios}, carousel: {max} }
  capabilities(account, approvals) → derived, never hand-declared   (fixes defect D2)
  limits(account) → live publishing caps where the API exposes them
  publish(account, PublishRequest) → { externalId, url }            (idempotency key required)
  status(account, externalId) → published | processing | failed      (reconciliation)
  metrics(account, since) → normalised metrics
  webhooks?: verify(signature) · handle(event)
```

- **Capabilities** are computed from what the provider implements, plus which permissions the
  platform has approved for this app (configuration flags) and which scopes the account granted.
  The UI never offers a format the provider can't publish.
- **Media profiles** drive the renderer and the transcoder: JPEG for Instagram, aspect ratios per
  placement, video codec and length limits.
- **Adding TikTok or X** means a new provider module, its media profiles and its review. There are
  no changes to scheduling, approvals, credits or analytics.

## 2.7 Submission packs (prepare in P4-0a)

For each platform, a folder holding:
- the app description and use cases;
- the per-permission justification text;
- the reviewer test credentials, handed over through the platform's secure field only;
- a screencast for each permission, recorded on staging against test accounts.

**Instagram and Facebook screencast script:**
1. Log in to BrandPilot.
2. Connect Facebook: the consent dialog lists each permission.
3. Select a Page and its linked Instagram account.
4. Create a creative and approve it.
5. Schedule it, then publish now.
6. Show the post live on Instagram and Facebook.
7. Open Analytics to show insights (`instagram_manage_insights`, `read_insights`).
8. Disconnect, then show the data deletion path.

**LinkedIn (Community Management API) script:**
1. Connect LinkedIn as a Page admin.
2. Pick an organisation.
3. Publish an image post to the Page.
4. Show organisation analytics.
5. Disconnect.

**Google (YouTube) demo video:**
1. Show the consent screen with the app name and domain.
2. Upload a Short from BrandPilot.
3. Show it on the channel.
4. Show analytics.
5. Revoke access.

## 2.8 Timeline (typical, not guaranteed)

| Week | Meta (Instagram, Facebook) | LinkedIn | Google (YouTube) |
|---|---|---|---|
| 0 | Create the app; start business verification | Create the app; verify the company Page; apply for Community Management API (Development) | Create the GCP project; verify the domain; consent screen |
| 1–2 | P4-0a live (privacy, terms, deletion callback). Build against the app in Development mode with test users. | Development tier: build and test | Build against test users (Testing mode) |
| 2–4 | Submit App Review (Advanced Access + Access Verification). Review takes days to weeks and may need a resubmission. | Submit the Standard tier upgrade with the demo | Submit OAuth verification (often several weeks) |
| 4–8 | Production permissions approved | Standard tier approved | Submit the YouTube API audit (weeks to months) and request a quota extension |

**Risks:**
- Rejections usually come from screencasts that don't show every permission in use, or from a
  privacy policy that doesn't mention the platform data.
- Reviews can't pass until the feature exists end to end on staging. Instagram and Facebook
  publishing (P4-3) has to be demo-ready by week 2–3.
