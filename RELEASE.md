# Releasing GitSynapse

Everything needed to produce a release is in this repository. This file covers
the two things the build cannot decide for you: **who you are** in the metadata,
and **how to sign** the builds so users do not meet a warning dialog.

---

## 1. Build everything

```bash
npm install
npm run dist:all      # Windows + Linux + macOS, ~10 minutes on a laptop
npm run release       # assemble release/v1.0.0/ with checksums and notes
npm run verify:release
```

| Command | Produces | Runs on |
| --- | --- | --- |
| `npm run dist:win` | `GitSynapse-setup.exe` (NSIS) | Windows, Linux, macOS |
| `npm run dist:linux` | AppImage, `.deb`, `tar.gz` (x64) | Windows, Linux, macOS |
| `npm run dist:mac` | `GitSynapse.app` in a `.zip` (x64 + arm64), `.dmg` on a Mac | Windows, Linux, macOS |
| `npm run release` | `release/v1.0.0/` with both source archives and `SHA256SUMS.txt` | anywhere |
| `npm run verify:release` | Unpacks every artifact and boots it | Linux, or wherever 7-Zip is installed |

Two platform facts worth internalising:

- **Windows packaging needs no Wine.** `electron-builder` normally shells out to
  `rcedit` through Wine, which does not work in a container without root. This
  repository instead asks electron-builder only for the unpacked app, brands the
  executable with `resedit` (a pure-JavaScript PE editor), and wraps it with
  `makensis` directly.
- **macOS bundles can be assembled anywhere, but only signed on a Mac.**
  `codesign`, `hdiutil` and `notarytool` are macOS tools. The zips built on
  Linux are complete and correct — the `.app` runs — they are simply unsigned.

---

## 2. Replace the placeholders

`package.json` ships with deliberately generic values, because a build tool
cannot know your details. Both are visible to users — `homepage` appears in
package managers, the email in the `.deb` control file.

```jsonc
"homepage": "https://github.com/gitsynapse/gitsynapse",   // → your repository
"repository": { "url": "https://github.com/gitsynapse/gitsynapse.git" },
"author": { "name": "GitSynapse", "email": "maintainer@example.com" },
"build": { "deb": { "maintainer": "GitSynapse <maintainer@example.com>" } }
```

Then rebuild. `example.com` is reserved by RFC 2606 precisely so a placeholder
cannot be mistaken for a working address — if you see it in a released `.deb`,
it was not replaced.

---

## 3. Signing

### Windows

An unsigned installer triggers SmartScreen: *"Windows protected your PC"* →
**More info** → **Run anyway**. That is a real drop-off for a GUI aimed at
beginners, so if you plan to distribute widely, sign it.

Options, cheapest first:

- **Azure Trusted Signing / a standard code-signing certificate** (~$100–400/yr).
  With a certificate in place, signing is `signtool sign /fd SHA256 ...` on the
  installer, or set `win.certificateFile` and `win.certificatePassword` in the
  build config and electron-builder will sign automatically.
- **Unsigned, with the checksum published.** Users can verify the download
  against `SHA256SUMS.txt`. This is what the current build does.

### macOS

Unsigned builds are blocked by Gatekeeper on first launch. Users have two ways
round it, both documented in the release notes:

- Right-click the app → **Open** → **Open** (once per machine), or
- `xattr -dr com.apple.quarantine /Applications/GitSynapse.app`

A warning-free build needs an **Apple Developer Program** membership ($99/yr)
and must be produced on a Mac:

```bash
# 1. Certificate in the keychain (Developer ID Application), or:
export CSC_LINK=/path/to/certificate.p12
export CSC_KEY_PASSWORD=…

# 2. Build, signed — the script detects the certificate and signs
npm run dist:mac

# 3. Notarize and staple the result
xcrun notarytool submit release/GitSynapse-1.0.0-macOS-arm64.zip \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" --wait
xcrun stapler staple release/mac-arm64/GitSynapse.app
```

`build-mac.js` deliberately does **not** disable signing: if a certificate is
present it is used, and `--unsigned` is there when you want to skip it on
purpose. Note that a hardened-runtime build also needs the `com.apple.security.cs.allow-jit`
entitlement for Electron; electron-builder's defaults cover this, but if you
customise entitlements, keep that one.

### Linux

No signing step. The AppImage has no repository metadata, and the `.deb` is
installed with `apt install ./file.deb`, which trusts the local file.

---

## 4. What was verified before shipping

`npm run verify:release` unpacks every artifact with the tools each format
provides (NSIS via 7-Zip, `dpkg-deb`, `unzip`, `tar`, the AppImage runtime) and
then:

- reads `package.json` and the provider registry **out of the shipped
  `app.asar`** — so the check is on the bundle, not on the source tree;
- confirms the product name, the version, all five providers, and that nothing
  user-visible still says GitDesk;
- checks what each format shows a user *before* the app starts: the `.desktop`
  entry, the launcher icon, `CFBundleName`/`CFBundleIdentifier` in the macOS
  `Info.plist`, the Mach-O architecture, and the Windows version resource;
- **extracts the bundle and boots the packaged server**, then queries
  `/api/system/info` and `/api/ai/settings` over HTTP.

The GUI is not started: there is no display in a build container, and the
Windows and macOS binaries are foreign. Everything up to the window — module
resolution, the server, the bundled assets — is covered.

---

## 5. Uploading

The assembled folder is the release:

```
release/v1.0.0/
  GitSynapse-1.0.0-Windows-x64-Setup.exe
  GitSynapse-1.0.0-macOS-arm64.zip
  GitSynapse-1.0.0-macOS-x64.zip
  GitSynapse-1.0.0-Linux-x86_64.AppImage
  GitSynapse-1.0.0-Linux-amd64.deb
  GitSynapse-1.0.0-Linux-x64.tar.gz
  GitSynapse-1.0.0-Source.tar.gz
  GitSynapse-1.0.0-Source.zip
  SHA256SUMS.txt
  RELEASE-NOTES.md
```

For a GitHub release, create a tag matching the version (`v1.0.0`) and attach
the six binaries plus `SHA256SUMS.txt`; the source archives are redundant there,
since GitHub generates its own. Put the text of `RELEASE-NOTES.md` in the
release body so the SmartScreen and Gatekeeper instructions are visible before
anyone downloads anything — they are the two questions every user will have.

---

## 6. Publishing the source on GitHub

Do this once. It puts the code itself on GitHub; the installers go on a Release
(step 5), not in the repository.

Create an empty repository on GitHub first — no README, no `.gitignore`, no
licence, because this project already has all three and a generated one would
collide. Then, from inside the project folder:

```bash
git init -b main
git add .
git commit -m "GitSynapse 1.0.0"
git remote add origin https://github.com/<your-account>/gitsynapse.git
git push -u origin main
```

`git add .` is safe here: `.gitignore` already excludes `node_modules/`,
`release/` and `screenshots/`, which is about 590 MB of machine-specific build
output. Check what is about to be committed before pushing if you want to be
sure:

```bash
git status --short | head -40
git count-objects -vH          # size-pack shows the final repository size
```

**Do not commit the installers.** GitHub warns on any file over 50 MB and
refuses anything over 100 MB, and the Windows installer alone is 72 MB. Release
assets (step 5) have no such limit and are the intended home for binaries — the
download links on a Release page are also what a user looking for "the app"
expects to find.

Before the first push, complete [step 2](#2-replace-the-placeholders): the
`homepage` and `repository` fields in `package.json` currently point at
`github.com/gitsynapse/gitsynapse`, and the author email is
`maintainer@example.com`. They are placeholders, and they show up in the
installer's properties on Windows.

### A note on `release/` in version control

Build outputs are large (about 510 MB for the full set) and reproducible from a
tag, so they do not belong in git. If you keep a copy, keep it outside the
repository; the source archives in `release/v1.0.0/` are the only ones that are
cheap to store.
