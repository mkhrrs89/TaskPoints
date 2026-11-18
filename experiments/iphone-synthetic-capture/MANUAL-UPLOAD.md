# Manual Cloudflare Pages upload

The ZIP is ready for the **proposed** project hostname:
`https://tp-synthetic-capture-taskpoints.pages.dev`

This hostname has NOT been reserved or confirmed by Cloudflare. No deployment has
been made. Confirm the assigned project hostname in your Cloudflare account before
uploading/deploying. Do not infer availability from a DNS lookup or a missing page.

## Create a new test project (a desktop browser is easiest)

1. Download `manual-upload/tp-synthetic-capture-taskpoints.zip` from this chat.
   If the file opens in a preview, use **Save as…**. Keep it as a ZIP for upload.
2. Sign in to the Cloudflare dashboard. Open **Workers & Pages**, then **Create
   application**. Choose **Pages**, then **Upload assets** / **Direct Upload**
   (the button wording may vary). Choose the Pages drag-and-drop upload option,
   not a Worker, Git connection, or your existing TaskPoints project.
3. Enter the NEW project name **tp-synthetic-capture-taskpoints**.
   Do not select or edit your existing TaskPoints website. No custom domain, DNS
   changes, GitHub connection, build command or API token is needed.
4. Before uploading or clicking **Deploy**, confirm that Cloudflare assigns the
   project hostname **tp-synthetic-capture-taskpoints.pages.dev**. It must match
   exactly. If the name is unavailable, Cloudflare shows a different hostname,
   or the screen does not yet confirm the assigned hostname, STOP and send the
   displayed name/message back in chat. Do not guess or upload to an existing site.
5. If the hostname matches, drag the ZIP into the upload area (or choose it with
   the file picker). The file list must show `index.html` at the top level with
   seven other assets. There must be no surrounding `site/` or repository folder.
6. Click **Deploy site** (or the equivalent deployment button). This publishes only
   the synthetic test website in the NEW project.
7. Copy the stable project URL ending in **tp-synthetic-capture-taskpoints.pages.dev**
   and send it here. A separate URL beginning with a deployment hash may also be
   displayed; that alternate hostname is intentionally refused by this harness.
   Do not change the origin check to accommodate the hash URL.
8. Stop there. We will verify the live site's configuration, headers, assets and
   synthetic-only behavior before you install or test it on your iPhone.

## If the hostname is different

The safest option is to send the exact assigned project hostname here **before
uploading**. I will produce a revised ZIP configured for that name and rerun the
checks. This needs no token, credentials, production access or automatic deployment.
The new test name must still begin **tp-synthetic-capture-** and use a separate project.

The only website setting that should change is the one assignment in `config.js`:

```js
window.SYNTHETIC_CAPTURE_ORIGIN = 'https://EXACT-NEW-TEST-HOSTNAME.pages.dev';
```

Replace the example with the actual dedicated hostname; use HTTPS, no trailing
slash, no path, and no wildcard. Do not alter `capture.js` or disable any guard.
The eight assets are then repackaged at the ZIP root and tested again. The provided
`package-site.py` performs the packaging and exact-file checks for a developer;
you do not need to run Python or edit code yourself. Prefer a freshly verified ZIP
from this chat over manually editing/recompressing files on your phone.

If a wrong-host package is accidentally deployed to the new test project, it should
show **FAIL — This origin is not approved…** before touching storage. Leave that
protection in place. Send the exact project hostname so we can prepare the right
package; do not switch to the production TaskPoints domain.

## ZIP contents and verification

Only these eight files are inside the ZIP:

- `index.html`
- `config.js`
- `capture.js`
- `ui.js`
- `style.css`
- `manifest.webmanifest`
- `icon.png`
- `_headers`

There are no application modules, user records, credentials, tests, logs, screenshots,
repository files, workers or analytics inside it. The synthetic fixture is generated
only when you choose **Create or resume synthetic records**. All website safety code
is byte-for-byte unchanged from the previously tested harness; only `config.js` is
configured for the proposed test origin.

`manual-upload/package-verification.json` records the exact origin, eight-file
inventory, per-file checksums, ZIP checksum and extraction checks. The file is
outside the ZIP and should not be uploaded. The browser suite runs against a fresh
extraction of the ZIP, including the actual packaged config at a locally simulated
HTTPS origin. It does not contact or deploy that hostname. **33 tests passed, 0 failed/cancelled/skipped.** Results are in
`manual-upload/package-tests.tap`.

At package preparation, live hosting, the assigned hostname and iPhone behavior
had not been verified. The owner subsequently reported successful physical-iPhone
testing; see [DEVICE-RESULTS.md](DEVICE-RESULTS.md). The assistant has not independently
verified the live hostname or deployed bytes. Main, the V2 base, TaskPoints hosting, real data and existing safety
requirements remain unchanged. Draft PR #1004 is not merged; V2 stays inactive.
