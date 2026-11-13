# Portable design

TermiPaw is a single `TermiPaw.exe` that runs from any writable folder:

- **No installation:** no installer, Start menu entry or uninstall entry. To remove it, delete the folder.
- **No system writes:** TermiPaw does not write to the registry, change environment variables, use the Windows Credential Manager, or write to `%APPDATA%`, `%LOCALAPPDATA%` or the system temporary folder. Everything is kept in a single `TermiPaw_Data` folder next to the program, so the whole folder can be copied to another computer or a USB drive.
- **Self-updating:** it downloads a signed new `TermiPaw.exe`, verifies it, replaces itself and restarts ([UPDATER.md](UPDATER.md)).

## Where data is stored

The folder is named after the program, not just `data`, so that it is recognizable when the program sits on the desktop or in the Downloads folder.

| Contents | Location |
| --- | --- |
| Hosts, trusted host keys, vault, chosen editor | `TermiPaw_Data\hosts.json`, `TermiPaw_Data\known_hosts.json`, `TermiPaw_Data\vault.json`, `TermiPaw_Data\editor.json` |
| Interface settings (language, theme, fonts) | `TermiPaw_Data\webview\`, the WebView2 user data folder |
| Working copies of remote files open in local programs | `TermiPaw_Data\editing\` |
| Terminal output you save | `TermiPaw_Data\logs\` by default; you can choose another place. The folder is only created when you save, and removed again if you cancel |

- **The program folder must be writable.** At startup TermiPaw writes a test file. If that fails (for example under `C:\Program Files`, on read-only media or a read-only share), a system dialog explains why and asks you to move the program to a folder such as the desktop or a USB drive, and TermiPaw exits. It never silently stores data somewhere else. At that point the interface has not started yet, so the message follows the language of the Windows regional settings.
- **`WEBVIEW2_USER_DATA_FOLDER` is ignored** by release builds, for this process only, because the environment variable would otherwise take precedence and move the interface data out of `TermiPaw_Data`.
- **Read but never written:** your `~/.ssh/known_hosts`, private key files at the paths you choose, and the system clipboard. After moving to another computer, private key paths may need to be updated.
- **Debug builds** keep their data in `target\debug\TermiPaw_Data`, and `TERMIPAW_DATA_DIR` can point elsewhere; the end-to-end tests rely on this to isolate their data. Release builds ignore the variable.

## Passwords

Saved passwords exist only in the [master password vault](VAULT.md). Without the vault, passwords cannot be saved and are entered on each connection; the backend refuses to save them as well, not only the interface. Turning the vault off deletes the passwords saved in it. A master password travels with the program folder better than a system credential store would.

## Measured: what the portable build writes to the system

`npm run test:footprint` runs the release executable in a temporary folder, turns on the vault, saves a host and a password, changes the interface language and closes normally. A 45-second control period without TermiPaw running estimates the changes made by the system itself.

Three runs gave the same results:

| Item | Result |
| --- | --- |
| TermiPaw's own data | All next to the program: `vault.json`, `vault.lock`, `webview` (`hosts.json` is absent because host information was encrypted in the vault) |
| Files | No new files with `termipaw` in their path under `%APPDATA%`, `%LOCALAPPDATA%`, the temporary folder, the desktop or ProgramData. In one run, three WebView2 cache changes belonged to a Windows component (`MicrosoftWindows.Client.CBS`) that was using that folder at the time; they did not recur |
| Credential Manager | Unchanged, no `termipaw` entries |
| User environment variables | Unchanged |
| `WEBVIEW2_USER_DATA_FOLDER` set for the tested process | Ignored; interface data still in `TermiPaw_Data\webview` |
| Registry | **Zero changes in all three control periods. While TermiPaw ran, the same 5 existing values were rewritten each time** (below) |

The five values already existed, no keys were created, and all are in the WebView2 runtime's own locations:

- `HKCU\Software\Microsoft\EdgeUpdate\ClientState\{F3017226-…}`, value `lastrun` (when the WebView2 runtime last ran)
- `HKCU\Software\Microsoft\EdgeWebView\PreferenceMACs\Default`, value `schedule_to_flush_to_disk`, and two values under its `extensions.settings` (integrity codes of browser preferences)
- `HKCU\Software\Microsoft\Windows\CurrentVersion\Search\JumplistData`, value `MSEdgeWebView.EBWebView.Default`

TermiPaw's own code makes no registry or environment variable calls (checked by searching the code), and `windows-sys` is built without its registry features. The dependency `winreg` is only used at build time to embed the icon, and `windows-registry`, pulled in by the HTTP library, only reads the system proxy settings during update checks. The values above are therefore written by the WebView2 runtime that TermiPaw depends on. Avoiding them would mean shipping a fixed-version WebView2 runtime with the program, which would make it much larger; this is not done.

So "TermiPaw does not write to the registry" means precisely: TermiPaw's code does not, but while it runs, the WebView2 runtime rewrites the five existing values above.

## Known limitations

- The program must be in a writable folder.
- After moving to another computer, private key paths may need to be changed, and saved passwords need the master password.
- Passwords cannot be saved without the vault, by design.
- A vault file written by a newer version may not open in an older one, so downgrading is not supported.
- **Antivirus false positives:** Windows Defender once flagged version 0.7.1 as `Trojan:Win32/Bearfoos.A!ml`. The `!ml` suffix marks a machine-learning verdict, not a match with known malware. New, unsigned programs without reputation are often flagged this way, and a program that downloads and replaces itself also behaves like a downloader. False positives can be reported to Microsoft; in the long run, code signing and download reputation help.
- Replacing the running program on FAT32 or exFAT USB drives has not been verified yet.
