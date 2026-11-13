# Online updates

TermiPaw updates itself from GitHub Releases; there is no separate update server. The program is a single `TermiPaw.exe` without an installer, so an update means downloading the new `TermiPaw.exe`, putting it in place of the running one, and starting again.

## How it works

1. TermiPaw reads `https://github.com/carsonxzhang/TermiPaw/releases/latest/download/latest.json`.
2. If the version is newer, a notice appears in the status bar. A dialog opens only when you click it, and you decide whether to update.
3. The new `TermiPaw.exe` is downloaded, and its signature and version are verified with the public key built into the program.
4. TermiPaw also checks that the signature was made for this release's file and that the file is a 64-bit Windows program.
5. The running program renames itself to `TermiPaw.exe.old`, the new program is moved into its place and started, and the old one exits.

The repository path is part of the update address, so the repository cannot be renamed or moved without breaking updates for installed copies.

## Security design

TermiPaw holds SSH credentials, and a single malicious update could steal them. Trust in updates therefore comes only from an offline signing key. Neither the GitHub account nor the network is trusted.

| Risk | Measure |
| --- | --- |
| The download is replaced | It must pass verification with the built-in public key, or it is discarded |
| The GitHub account is compromised | The private key is not on GitHub; releases are signed on the publisher's computer. An attacker can replace files but cannot sign them |
| Downgrade to a version with known flaws | The version must be newer than the running one. `requireSignedVersion` requires the signed version to match `latest.json`, so an old build cannot be served under a new version number |
| Another file signed with the same key | The signature records the signed file name and version: the name must be `TermiPaw.exe` and the version must be the one being installed |
| A wrong file is published by mistake | The file must be a 64-bit Windows program of at least 1 MiB; the release script checks this before signing as well |
| The interface is compromised | The updater plugin's own commands are not exposed to the interface; the address and public key are decided by the backend. At most, a compromised interface can install a newer, properly signed version |
| Malicious release notes | Release notes are not covered by the signature. They are treated as untrusted text: control and bidirectional characters are removed, the length is limited, and they are shown as plain text |

Unit tests in `updater.rs` check these settings. Turning on any `dangerous*` option or `allowDowngrades` fails the tests.

**The signing key is the core of this design:**

- If it is lost, installed copies can no longer receive updates and users have to download new versions by hand. It is backed up offline.
- If it leaks, anyone who can also replace files on GitHub can push arbitrary programs to every user. In that case a new version with a new public key would be published, and users would be told publicly to download it by hand.

## Replacing the running program

Windows does not allow overwriting a running program, but it allows renaming it.

- **Writable folder first:** before downloading, TermiPaw tries to write a file in its own folder. If that fails (for example in a read-only location), it explains why and asks you to download the new version by hand, instead of downloading for nothing.
- **Write `.new`, then swap:** the new program is written as `TermiPaw.exe.new` and read back to confirm it matches the verified download before any rename.
- **Every failure is rolled back:** if the second rename fails, `.old` is renamed back and `.new` is deleted, leaving everything as it was.
- **Hand-over:** the new program starts with `--after-update=<old process id>` and waits up to 15 seconds for the old process to exit before creating its window, because the old process still holds the WebView2 data folder.
- **Clean-up:** `TermiPaw.exe.old` is deleted after the new version has run for one minute. If the new version crashes right away, `.old` is still there and can be renamed back by hand.
- **Development builds never replace themselves:** programs running from `target\debug` or `target\release` refuse to update.

## User experience

- **No automatic installation:** updating restarts TermiPaw, which interrupts SSH sessions, transfers and file uploads. The update dialog lists what will be interrupted.
- **No focus stealing:** a new version is only announced in the status bar, so a command being typed never lands on a dialog button.
- **Can be turned off:** checking at startup lets GitHub see your IP address. It can be turned off in Settings; you can still check manually in the About window.
- **Quiet failures:** a failed check at startup is not reported; a manual check shows the reason.
- **Vault:** while the vault is locked, nothing is checked or shown until you unlock. After an update the vault is locked and needs the master password again. Updates never touch the `TermiPaw_Data` folder.
- **No automatic rollback:** a vault file written by a newer version may not open in an older one, so going back to an older version is not supported.

Without a configured public key and address, no update request is ever made. Debug builds (`npm run app` and the end-to-end tests) ignore the shipped configuration and only use test environment variables, so development never contacts GitHub.

## Publishing a release

One-time setup:

1. Generate the signing key with a password: `npx tauri signer generate -w "$HOME\.tauri\termipaw.key"`.
2. Back up `termipaw.key` and its password separately.
3. Put the contents of `termipaw.key.pub` in `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. This is already done; a unit test checks the key format and the address.
4. Install the [GitHub CLI](https://cli.github.com/) and run `gh auth login`.

For each release:

1. Update the version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and `src-tauri/tauri.conf.json`, and add the release to `CHANGELOG.md`. Merge to `main` and push.
2. Write the release notes to a file and run:

   ```powershell
   npm run release -- --notes-file notes.md
   ```

   The script checks the version numbers, the public key and the state of the repository, runs `cargo audit` (install it with `cargo install cargo-audit --locked`), asks for the signing key password, builds `termipaw.exe`, copies it to `TermiPaw.exe`, signs it, writes `latest.json`, and creates a draft release. Use `--key <path>` for a key in another location and `--dry-run` to build and sign without uploading.
3. Download the executable from the draft release, compare its SHA-256 checksum and try it.
4. Publish the release. Users see the update the next time TermiPaw starts.

If a release has a serious problem, do not pull it and expect users to go back: version numbers only move forward, so publish a fixed version with a higher number.

## Not yet verified

- **Replacing the program on a USB drive** formatted as FAT32 or exFAT.
- **Antivirus software** that may block a program from renaming and restarting itself. Windows Defender has flagged an unsigned build once as `Trojan:Win32/Bearfoos.A!ml`, a machine-learning verdict rather than a known signature; see [PORTABLE.md](PORTABLE.md).
- **Two running instances:** an update only handles the instance that installs it.
- **Proxies:** the system proxy settings are used, but this has not been tested behind a proxy.

## Not done yet

- **Mirrors:** if GitHub is unreachable, checking and downloading fail. The updater supports several addresses and tries the next one on network errors; a mirror is safe to add because its files must pass the same signature check.
- **Windows code signing:** unrelated to update signing. Without it, Windows SmartScreen may warn on first download. Open source projects can apply for a free certificate from the SignPath Foundation.
