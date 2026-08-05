# Build instructions — SoloSend

## Summary

**There is no build step.** No transpiler, bundler, minifier, preprocessor, or
code generator is used anywhere in this project. There are no dependencies: no
`package.json`, no `node_modules`, and no third-party libraries of any kind.

Every file inside the `.xpi` is the original, hand-written, human-readable source
file, byte-for-byte identical to the corresponding file in this source archive.
"Building" consists only of creating a ZIP archive of five paths and renaming it
to `.xpi`.

SoloSend is MIT licensed; see `LICENSE`.

## Operating system and build environment

Any operating system. Verified on Windows 11 (PowerShell 7.6.4). Scripts are
provided for both PowerShell and POSIX shells.

Nothing needs to be compiled or installed. The only program required is a ZIP
archiver:

| Platform | Program | Version | Installation |
| --- | --- | --- | --- |
| Windows | PowerShell (`build.ps1`) | 5.1 or newer; verified on 5.1 and 7.6.4 | Windows PowerShell 5.1 is built into Windows 10/11 — nothing to install |
| macOS | Info-ZIP `zip` (`build.sh`) | 3.0 or newer | Preinstalled |
| Linux | Info-ZIP `zip` (`build.sh`) | 3.0 or newer | `apt install zip` / `dnf install zip` |

`build.ps1` writes the archive through `System.IO.Compression` instead of
`Compress-Archive`, because Windows PowerShell 5.1's `Compress-Archive` stores
backslash entry names, which are invalid in a ZIP and can prevent Thunderbird
from loading the `.xpi`.

Optional, for verification only — not required to produce the package:

- **Node.js**, any version 18 or newer, from <https://nodejs.org>. Used solely to
  run `node --check` as a syntax check on the two JavaScript files. It does not
  touch, rewrite, or generate any shipped file.
- **`sha256sum`** (Linux/macOS) or **`Get-FileHash`** (Windows, built in) to
  confirm file identity, as described under *Verifying an exact copy*.

## Build steps

From the root of this source archive:

**Windows**

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
```

**macOS / Linux**

```sh
sh build.sh
```

Either script writes the installable add-on to `dist/solosend-<version>.xpi`,
where `<version>` is read from the `version` field of `manifest.json`.

### Manual equivalent

The scripts do exactly this and nothing more:

1. Change to the source root directory.
2. Create a ZIP archive containing these five paths, with `manifest.json` at the
   archive root:
   - `manifest.json`
   - `background.js`
   - `dialog/`
   - `icons/`
   - `LICENSE`
3. Rename the resulting `.zip` to `.xpi`.

Nothing is copied, rewritten, concatenated or transformed on the way in.

On macOS or Linux that is a single command:

```sh
zip -r -X solosend.xpi manifest.json background.js dialog icons LICENSE
```

(`zip` keeps the `.xpi` name as given, so step 3 is unnecessary there.)

If you reproduce step 2 on Windows with `Compress-Archive`, use **PowerShell 7 or
newer**. Windows PowerShell 5.1 writes backslash entry names and produces an
archive Thunderbird may refuse. `build.ps1` has no such constraint.

### Files deliberately not shipped

`test-files/`, `README.md`, `BUILD.md`, `build.ps1`, `build.sh`, `.gitignore` and
`dist/` are development-only material and are intentionally excluded from the
`.xpi`. `test-files/` contains sample recipient lists used for manual testing.

## Verifying an exact copy

`build.ps1` normalises entry order, entry names and entry timestamps, so running
it twice on the same machine yields a **byte-identical** `.xpi` (verified: two
consecutive runs under Windows PowerShell 5.1 produced the same SHA-256, as did
two runs under PowerShell 7.6.4).

Across *different* runtimes the container bytes do differ, because .NET Framework
4.x and .NET 8 ship different `Deflate` implementations and therefore compress
the same input to different bytes. `build.sh` differs again for the same reason.
The archived **file contents are identical in every case** — only the compression
of them differs.

So verify the contents, not the container. Both build scripts print the SHA-256 of
every shipped file; those hashes are runtime-independent. Extract the submitted
`.xpi` and compare:

```sh
# Linux / macOS
unzip -o solosend-<version>.xpi -d /tmp/submitted
cd /tmp/submitted && sha256sum manifest.json background.js dialog/* icons/* LICENSE
```

```powershell
# Windows
Expand-Archive solosend-<version>.xpi -DestinationPath .\submitted
Get-ChildItem .\submitted -Recurse -File | Get-FileHash -Algorithm SHA256
```

Every hash must match the corresponding file in this source archive exactly.

## Note on validator warnings

`addons-linter` reports "This API has not been implemented by Firefox" for
`compose.getComposeDetails`, `compose.listAttachments`, `compose.beginNew`,
`compose.addAttachment`, `compose.sendMessage` and `composeAction.onClicked`, and
flags the `compose` permission as invalid. These are Thunderbird-only
MailExtension APIs that the Firefox-oriented validator does not recognise. They
are expected and are not defects.

`unlimitedStorage` is requested because scheduled sends persist the message
template and its attachments (bounded at 25 MB, see `MAX_ATTACH_BYTES` in
`background.js`) to `storage.local` so a run can fire after a restart.
