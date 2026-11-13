# Roadmap

TermiPaw aims to stay small, fast and portable, secure by default, and focused on the terminal, the file panel and the connection between them. A feature is added only if it fits that aim; the "Not planned" list below is as deliberate as the plans.

Plans can change. Version numbers indicate order, not dates.

## 0.8 — Authentication

- Keyboard-interactive authentication, including servers that ask for a one-time code (two-factor authentication), and servers such as FreeBSD that allow only keyboard-interactive login by default.
- Import hosts from `~/.ssh/config`. The file is read only, never changed.

## 0.9 — Port forwarding and the file panel

- Local, remote and dynamic (SOCKS) port forwarding.
- File panel: sorting, showing or hiding hidden files, and faster listing of folders that contain many symbolic links.

## 1.0 — Stability

- The test suite against a real OpenSSH server runs before every release.
- Self-update verified on FAT32 and exFAT USB drives.
- Performance baselines: startup time, memory use, large terminal output, large transfers, and folders with tens of thousands of files.
- Native-speaker review of the translations.
- Windows code signing.

## Later, under consideration

- Non-UTF-8 file names in the file panel. The SFTP library replaces invalid UTF-8 before TermiPaw sees the name, so this needs a change in the library first.
- A mirror for update downloads in regions where GitHub is hard to reach.

## Not planned

- Jump hosts (ProxyJump).
- Generating SSH keys and deploying public keys to servers.
- Automatic session logging. Saving the current output by hand is supported.
- Typing commands into a shell automatically after connecting, for example to turn on directory following. TermiPaw only types into the shell when you click a button for it.
- Accounts, cloud sync and telemetry.
- AI features, plugins and scripting.
- Telnet, serial connections and other protocols.
- SHA-1 `ssh-rsa` host keys and signatures.

## Release cadence

- **Security fixes** are released as soon as they are ready, normally within a week.
- **Bug fixes** are released once user-visible fixes have accumulated, at most every two weeks. Every release prompts all users to update, so trivial changes wait for the next release.
- **Feature releases** come roughly every one to two months, each built around one main theme.
- **Before every release:** the full end-to-end test suite, the test suite against a real OpenSSH server, and dependency audits (`cargo audit` and `npm audit`) must pass.
- Changes are listed in [CHANGELOG.md](../CHANGELOG.md). Release notes are written in English, with a Chinese section.
