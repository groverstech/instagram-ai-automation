# Android app (Trusted Web Activity)

BrandPilot is a server-rendered web app, so the Android app is a **Trusted Web Activity
(TWA)**: a small APK/AAB that opens your deployed site full-screen, with no browser bar.
Server deploys update the app instantly; there is no separate mobile codebase.

What the web app provides:

| Requirement | Where |
|---|---|
| Web app manifest | `/manifest.webmanifest` (`src/app/manifest.ts`) |
| Icons (any + maskable, 192/512) | `/icons/*.png` (`src/app/icons/[file]/route.tsx`) |
| Digital Asset Links | `/.well-known/assetlinks.json` (env: `ANDROID_PACKAGE_NAME`, `ANDROID_CERT_SHA256`) |
| Phone layout | mobile top bar + navigation drawer; full-screen post editor in the calendar |

## 1. Try it on a phone without packaging

```bash
cd web && npm run dev
adb reverse tcp:3000 tcp:3000      # phone's localhost:3000 → your computer
```

Enable **USB debugging** on the phone (Settings → About phone → tap *Build number* 7×,
then Developer options), open Chrome on the phone at `http://localhost:3000`, and debug from
`chrome://inspect` on your computer. Chrome's menu → **Install app** installs it as a PWA.

## 2. Deploy to a public https domain

Use a host with a persistent disk (uploads are stored on local disk today) and managed
Postgres. Set at least `APP_URL`, `APP_SECRET`, `DATABASE_URL`, `ANTHROPIC_API_KEY`.
Check that `https://your-domain/manifest.webmanifest` loads.

## 3. Build the APK with Bubblewrap

Needs Node 22; Bubblewrap offers to install JDK 17 and the Android SDK on first run.

```bash
npm i -g @bubblewrap/cli
mkdir brandpilot-android && cd brandpilot-android
bubblewrap init --manifest https://your-domain/manifest.webmanifest
#   Application ID: e.g. com.yourco.brandpilot
#   Let it create a signing key (android.keystore). Back it up with its passwords;
#   losing it means you can't update the app.
bubblewrap build        # → app-release-signed.apk and app-release-bundle.aab
```

## 4. Link the app and the site

```bash
bubblewrap fingerprint list
# or: keytool -list -v -keystore android.keystore   (copy the SHA256 line)
```

On the server set:

```
ANDROID_PACKAGE_NAME=com.yourco.brandpilot
ANDROID_CERT_SHA256=AA:BB:...:FF
```

Redeploy and check `https://your-domain/.well-known/assetlinks.json` returns your package.
It returns 404 until both variables are set, and 500 if a fingerprint is malformed.

## 5. Install and test

```bash
adb install -r app-release-signed.apk
```

If an address bar appears at the top, the link check failed: re-check the package name and
fingerprint, then clear the app's data and reopen. `adb logcat | grep -i "digital asset"`
shows the verification result.

Checklist: sign-up/login, onboarding with camera/gallery uploads, navigation drawer,
creative generation and download, calendar post editing (drag-and-drop is mouse-only; edit the
date in the post panel on touch devices), assistant, OAuth connect (opens and returns), Stripe
Checkout (opens and returns).

## 6. Google Play (optional)

1. Play Console → create the app → upload `app-release-bundle.aab` to **Internal testing**.
2. With **Play App Signing**, copy Play's app-signing SHA-256 (Setup → App signing) and add it
   to `ANDROID_CERT_SHA256`, comma-separated after your upload key's fingerprint.
3. Add testers and install from the opt-in link.
