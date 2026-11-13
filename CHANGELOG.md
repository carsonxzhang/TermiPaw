# Changelog

Notable changes to TermiPaw. Version numbers follow [Semantic Versioning](https://semver.org/); before 1.0, minor versions may change behavior.

## 0.7.2 — first public release

Earlier versions were not published.

**Connections**
- Password, private key and SSH Agent (Windows OpenSSH Agent, Pageant) authentication
- Host list with groups, search, command palette (`Ctrl+K`) and quick connect (`user@host:port`)
- Several sessions per host and automatic reconnection
- Host key verification against TermiPaw's records and `~/.ssh/known_hosts` (read only)

**Terminal**
- Toolbar with copy, paste, find, clear, save current output, encoding and file panel
- Terminal encodings: UTF-8, GB18030 / GBK, Big5, Shift_JIS, EUC-JP, EUC-KR, Windows-1252, per host or per session
- Confirmation before multi-line pastes; links open with `Ctrl`+click, http and https only

**Files**
- SFTP upload and download of files and folders, drag and drop, transfer queue
- Atomic uploads: the target is replaced only after the upload completes
- Open remote files in local programs, with changes uploaded on save
- File panel can follow the terminal directory (bash, zsh)

**Security**
- Master password vault (Argon2id, XChaCha20-Poly1305) with optional recovery key and optional encryption of host information; locks when idle, when Windows locks and before sleep
- No plain-text passwords; passwords can only be saved in the vault
- Signed self-updates verified with an offline key

**Portable**
- Single executable; all data in a `TermiPaw_Data` folder next to it; no registry, `%APPDATA%` or Credential Manager writes by TermiPaw
- Interface in English, 简体中文, 繁體中文, 日本語, 한국어, Français, Español and Deutsch
