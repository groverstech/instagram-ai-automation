# Platform readiness (PR 4.3)

What BrandPilot provides for the social platforms' app reviews, and how to configure it. The
status of every launch gate is in [LAUNCH_READINESS.md](LAUNCH_READINESS.md).

## Public legal pages

| URL | Source | Meta App Dashboard field |
|---|---|---|
| `/privacy` | `content/legal/privacy.md` | Privacy Policy URL |
| `/terms` | `content/legal/terms.md` | Terms of Service URL |
| `/data-deletion` | `content/legal/data-deletion.md` | User data deletion → Data deletion instructions URL (if you use instructions instead of the callback) |

The pages need no sign-in, and platform reviewers and crawlers can read them.

**The text in the repository is a draft for your counsel, not legal advice.** Each page shows a
"Draft" banner until its front matter says `status: final`. **Don't submit a page to a platform
review while it shows the banner.** To publish the final text:

1. Replace the markdown in `content/legal/<page>.md` with counsel's text. Supported formatting:
   `#`, `##` and `###` headings, paragraphs, `-` and `1.` lists, `**bold**`, and
   `[links](https://…)`. Nothing else is interpreted; HTML shows as text.
2. Set `status: final` and `updated: YYYY-MM-DD` in the front matter, and merge.
3. Set `LEGAL_ENTITY_NAME` (the company that operates BrandPilot) and `LEGAL_CONTACT_EMAIL` on the
   server. They fill `{{company}}` and `{{contact}}` in the text, and `{{appUrl}}` comes from
   `APP_URL`. A missing value shows as a visible "[… to be confirmed]" marker, never a blank.

## Meta (Instagram and Facebook) callbacks

Enter these in the Meta App Dashboard (App settings → Basic, and Facebook Login → Settings),
with your public domain:

| Field | URL |
|---|---|
| User data deletion → Data deletion callback URL | `https://<domain>/api/platforms/meta/data-deletion` |
| Deauthorize callback URL | `https://<domain>/api/platforms/meta/deauthorize` |

Both verify Meta's `signed_request` with `META_APP_SECRET` (HMAC-SHA256, constant-time compare).
They refuse a request that is malformed, signed with another key, uses another algorithm, or is
more than 24 hours old or dated in the future. They answer 400 to invalid requests and 503 if
`META_APP_SECRET` isn't set.

- **Data deletion:**
  - Records the request in `data_deletion_requests`.
  - Deletes the Facebook Pages and Instagram accounts connected through that person's Meta login:
    their tokens, names, avatars and account metrics.
  - Deletes the platform metrics of posts published through those accounts, and clears the
    posts' platform IDs and links. The brand's own posts and creatives stay, detached from the
    deleted accounts.
  - Answers `{ url, confirmation_code }`. `/data-deletion/status?code=…` shows only the status
    and dates.
  - Each affected brand gets a `social.data_deletion` event in the Security log.
- **Deauthorise:**
  - Marks that person's accounts revoked and destroys their tokens.
  - Publishing to those accounts stops, because publishing needs an active account.
  - Each account gets a `social.deauthorized` event.

**How people are matched.** Meta identifies the person by their app-scoped user ID. BrandPilot
records it on every account connected through that login (`social_accounts.platform_user_id`,
read from `/me` during the OAuth exchange). **Accounts connected before migration 0011 don't have
it until they're reconnected**, so the callbacks can't match them. Ask existing Meta connections
to reconnect before submitting the review.

## What the Social Accounts page promises

Each capability says what BrandPilot can do on that platform **today**:

| State | Meaning |
|---|---|
| Available | Implemented, and works with standard access |
| Needs the platform's app review | Implemented, but the platform allows it only after its review (TikTok direct posting) |
| Not in BrandPilot yet | The platform offers it, but BrandPilot doesn't implement it yet (carousels, video, LinkedIn organisation features, YouTube uploads) |
| Not offered by the platform | The platform's API doesn't offer it |

`src/server/social-capabilities.test.ts` fails if a capability claims more than the provider
implements.

## Publish media

Platforms download the image to publish from a signed link that's valid for 24 hours:
`/api/public/media/<token>.jpg`. It serves baseline sRGB JPEG with the sRGB profile embedded and
transparency flattened onto white, because Instagram's publishing API accepts JPEG only. Links
issued before this change (`.png`) still serve PNG until they expire. Serving this media from
object storage and a CDN is part of PR 4.2.

## Self-service deletion (PR 4.3b)

**Settings → Delete data.** Each option is refused, deleting nothing, when its condition fails:

| Option | Who | Confirmation | Refused while |
|---|---|---|---|
| Delete a brand | Owners and admins with access to every brand | The brand's name | An AI job is queued or running for the brand, or a post is being published |
| Delete the organisation | Owners | Password | A paid subscription is active (cancel it in Billing first), or any brand meets the condition above |
| Delete my account | Everyone | Password | You're the only owner of an organisation that has other members |

Deleting a brand removes every row that belongs to it (through `ON DELETE CASCADE`) and its stored
files (`brands/<id>/…`), cancels its queued publishing and metric-sync jobs, and clears it as anyone's
active brand. Deleting an account also deletes organisations where you're the only member, leaves the
others (recorded as `member.remove`), and signs you out. Password confirmations are rate-limited like
sign-in.

**Kept:** the AI usage ledger (billing reconciliation) and the Security log (security
investigations). They hold the deleted internal IDs and, in `social.connect` events, the platform account IDs, but no names, text or files. The Security log records
`brand.delete`, `workspace.delete` and `account.delete`.

## Submission packs and the reviewer account (PR 4.3c)

- **Meta (Instagram and Facebook):** [submissions/META.md](submissions/META.md). It has the
  pre-submission checklist, the app description, every requested permission mapped to the exact
  API calls and screens that use it, the use-case text for the form, and the screencast script.
  One open decision: whether `business_management` is needed.
- **Reviewer account:** `npm run reviewer:setup -- --email reviewer@<domain> [--reset]`. It
  creates a user, an organisation and a review brand with approved Instagram and Facebook posts
  and their creative, makes no AI calls, prints the password once, and prints a direct link to
  each post. `--reset` refuses any account that shares an organisation with other people.
- **LinkedIn and YouTube packs** come with PRs 4.7 and 4.8: their organisation posting and uploads
  aren't built yet, and reviewers need to see each permission in use.

**Note on publishing without R2.** Single-image publishing to Instagram and Facebook works today
through the app's signed media links (`/api/public/media/<token>.jpg`) when `APP_URL` is a public
HTTPS domain. On a single-instance deployment the Meta review and beta publishing don't have to
wait for PR 4.2. R2 is still needed for more than one instance, for the render cache (plan defect
D6) and for video.
