# Meta App Review submission pack (Instagram and Facebook)

For the owner, who submits it from the Meta App Dashboard. **Submit only when every item in §1 is
done.** Permissions and endpoints were checked against `src/server/social/providers/meta.ts` on
22 Nov 2026; re-check Meta's current requirements when submitting.

## 1. Before submitting

| # | Item | Where | Status |
|---|---|---|---|
| 1 | Production domain on HTTPS; `APP_URL` set to it | Hosting | Owner |
| 2 | Final legal text (`status: final`), `LEGAL_ENTITY_NAME`, `LEGAL_CONTACT_EMAIL` | `content/legal/*.md`, server environment | Owner + counsel |
| 3 | App settings → Basic: Privacy Policy URL `https://<domain>/privacy`, Terms URL `https://<domain>/terms`, app icon 1024×1024, category, contact email | Meta App Dashboard | Owner |
| 4 | Data deletion callback `https://<domain>/api/platforms/meta/data-deletion`; Deauthorize callback `https://<domain>/api/platforms/meta/deauthorize` | Meta App Dashboard | Owner |
| 5 | Facebook Login → Valid OAuth redirect URIs: `https://<domain>/api/oauth/facebook/callback` and `https://<domain>/api/oauth/instagram/callback` | Meta App Dashboard | Owner |
| 6 | Business verification of the legal entity | Meta Business Manager | Owner |
| 7 | Test accounts: a Facebook Page you manage and an Instagram **Business or Creator** account linked to it | Meta | Owner |
| 8 | Reviewer account in BrandPilot (`npm run reviewer:setup`, §4) | Production server | Operator |
| 9 | Screencasts recorded against the production domain (§5) | — | Owner |
| 10 | Decision on `business_management` (§3) | — | Owner |

## 2. App description (for the review form)

BrandPilot is a marketing workspace for small businesses and agencies. It learns a brand from what
the business provides, plans content, and generates images and captions with AI. A person in the
organisation reviews and **approves every post**; BrandPilot then publishes the approved post to the
Facebook Pages and Instagram professional accounts the business connected, at the time they chose,
and shows each post's results. Nothing is published without that approval. People can disconnect an
account at any time in Social Accounts, which deletes its token and data, and we honour Meta's
data-deletion and deauthorisation callbacks.

## 3. Permissions and how each is used

| Permission | What BrandPilot does with it | API calls | Where the reviewer sees it |
|---|---|---|---|
| `pages_show_list` | Lists the Pages the person manages so they can choose which to connect | `GET /me/accounts` (id, name, picture, Page token, linked Instagram account) | Social Accounts → Connect Facebook → the connected Pages appear |
| `pages_manage_posts` | Publishes the approved image post to the chosen Page | `POST /{page-id}/photos` (image URL, message) | Content Calendar → an approved post → Publish now → the post on the Page |
| `pages_read_engagement` | Shows the Page's follower count and each published post's reactions, comments and shares | `GET /{page-id}?fields=followers_count,fan_count`; `GET /{post-id}?fields=reactions.summary,comments.summary,shares` | Analytics |
| `read_insights` | Shows reach and impressions of published Page posts | `GET /{post-id}/insights?metric=post_impressions_unique,post_impressions` | Analytics |
| `instagram_basic` | Identifies the linked Instagram professional account (username, name, picture) and its follower count | `GET /me/accounts` (`instagram_business_account{…}`); `GET /{ig-user-id}?fields=followers_count` | Social Accounts → the Instagram account appears; Analytics |
| `instagram_content_publish` | Publishes the approved image post to Instagram | `POST /{ig-user-id}/media` (image URL, caption), `GET /{container-id}?fields=status_code`, `POST /{ig-user-id}/media_publish`, `GET /{media-id}?fields=permalink` | Content Calendar → Publish now → the post on Instagram |
| `instagram_manage_insights` | Shows each Instagram post's reach, views, saves and shares, and the account's reach and profile views | `GET /{media-id}/insights?metric=reach,views,saved,shares`; `GET /{ig-user-id}/insights?metric=reach,profile_views` | Analytics |
| `business_management` | **Not called directly.** Requested so Pages owned through a business portfolio are returned by `/me/accounts`. | — | — |

**Decision needed on `business_management`:** Meta reviews advanced permissions strictly, and asks
for a visible use of each one. Before submitting, connect a test Page that's owned through a business
portfolio **without** this permission (remove it from `SCOPES` in `meta.ts` on staging). If the Page
and its Instagram account are still listed, drop the permission; if not, keep it and say so in the
form.

Only single-image posts are published. Carousels, Reels and Stories aren't built, so their
features aren't requested.

## 4. Reviewer account

Create it on the production server, then give the credentials to Meta **only in the review form's
secure "test credentials" field**, never in email or chat:

```
npm run reviewer:setup -- --email reviewer@<your-domain>
```

It creates (or, with `--reset`, recreates) a user, an organisation and a brand named "Kora Ceramics
(review)", with an approved, ready-to-publish post for Instagram and one for Facebook, and their
type-led creative. The posts are dated an hour after setup (approved, not scheduled: nothing publishes
by itself), and the command prints a direct link to each, which works whatever month the review
happens in. It makes no AI calls.
**Two-step verification:**
- The account is created with two-step verification **already on**, because it's mandatory for organisation owners in production.
- The command prints the password, ten single-use **recovery codes** and an authenticator setup key, once.
- Give Meta the password and **three** recovery codes in the test-credentials field, with this note: *"Sign in, then choose 'Use a recovery code' and enter one code. If BrandPilot asks 'Confirm it's you' again (it does after 15 minutes, before connecting an account), enter another code."*
- The sign-in counts as a fresh verification for 15 minutes, so connecting the test accounts right after signing in needs no further code.

The reviewer then connects your **test** Page and Instagram account.
Delete the reviewer's organisation (Settings → Delete data) after the review.

## 5. Screencast script (record on the production domain with the test accounts)

1. Sign in to BrandPilot as the reviewer.
2. **Social Accounts → Facebook → Connect.** The Facebook dialog lists every requested permission;
   continue as the test user and choose the test Page. *(`pages_show_list`, `instagram_basic`)*
3. Back in BrandPilot, show the Page and the linked Instagram account under Social Accounts.
4. **Content Calendar:** open the approved post "Made to last (Instagram)" (or its direct link),
   choose the Instagram account, and **Publish now**. Show the post on Instagram. *(`instagram_content_publish`)*
5. Repeat with the Facebook Page; show the post on the Page. *(`pages_manage_posts`)*
6. **Analytics:** sync metrics and show reach, impressions, likes, comments, saves and followers for
   both. *(`pages_read_engagement`, `read_insights`, `instagram_manage_insights`)*
7. **Social Accounts → Disconnect** the Instagram account; show it's gone.
8. Open `/data-deletion` and `/privacy` to show the deletion instructions and the data use.

Keep each recording short and narrate which permission is in use. Captions in English.

## 6. Use-case text (per permission, for the form)

- **pages_show_list:** "When a business connects Facebook, we list the Pages they manage so they can
  choose which ones BrandPilot may publish to."
- **pages_manage_posts:** "After a person in the business approves a post in BrandPilot, we publish
  that image post to the Page they selected, at the time they chose."
- **pages_read_engagement / read_insights:** "We show the business how their published posts perform
  (reactions, comments, shares, reach, impressions) and their follower count, so they can plan
  better content."
- **instagram_basic:** "We identify the Instagram professional account linked to the chosen Page
  (username, name, picture, followers) so the business can choose it as a publishing destination."
- **instagram_content_publish:** "After approval in BrandPilot, we publish the approved image and
  caption to the business's Instagram professional account."
- **instagram_manage_insights:** "We show the business the reach, views, saves and shares of the posts
  we published, and their account's reach and profile views."
