# Contributing to TermiPaw

Thank you for your interest. Bug reports, translation corrections and focused pull requests are welcome. For larger changes, please open an issue first: TermiPaw deliberately stays small, and [ROADMAP.md](docs/ROADMAP.md) lists features that are not planned.

Security problems should be reported privately; see [SECURITY.md](SECURITY.md).

## Setting up

You need Windows, Node.js 22, Rust (stable), the Visual Studio C++ build tools and the WebView2 runtime.

```bash
npm install
npm run app          # development mode (tauri dev)
npm run app:build    # release build: builds/TermiPaw_<version>_x64.exe
```

A local SSH and SFTP server is included for development. It listens on `127.0.0.1:2222`, accepts any user name with the password `demo`, and offers a demo shell and a real SFTP sandbox inside the system temporary folder:

```bash
cd src-tauri
cargo run --example dev_server
```

Connect to `demo@127.0.0.1:2222` from TermiPaw.

## Tests

```bash
cd src-tauri && cargo test   # Rust unit tests, including SFTP failure scenarios and fuzz tests
npm run test:unit            # frontend unit tests (Node 22.18 or later)
npm run test:e2e             # end-to-end tests that drive the real app and the dev server
```

The end-to-end tests open the program window and system file dialogs and temporarily replace the clipboard text (restored afterwards), so do not use the computer while they run (about 15 minutes). `TERMIPAW_TEST_ONLY=<text>` runs only the suites whose name contains the text. Their data stays in temporary folders.

Two more suites are run before releases:

- `npm run test:openssh` tests against a real OpenSSH server on a disposable Linux machine (the account needs sudo), given by `TERMIPAW_TEST_HOST`, `TERMIPAW_TEST_USER` and `TERMIPAW_TEST_PASSWORD`. It only works under `/run/termipaw-test` and `~/termipaw-test`, starts its own sshd on ports 2200–2203 and cleans up afterwards. Do not point it at a production server.
- `npm run test:footprint` runs the release build and compares files, the current user's registry, the Credential Manager and environment variables before and after; see [PORTABLE.md](docs/PORTABLE.md).

CI runs the frontend build, unit tests, Clippy, Rust tests and dependency audits on every push and pull request.

## Project layout

```
src/                     interface (React + TypeScript)
  components/            title bar, sidebar, terminal, file panel, dialogs, command palette
  lib/api.ts             typed wrappers for the backend commands
  lib/store.ts           application state (zustand)
  lib/shell.ts           shell integration: directory reports, shell state
  lib/encoding.ts        terminal encodings (uses the WebView's decoders)
  lib/names.ts           safe display of untrusted file names
  i18n/                  texts in 8 languages; en.ts is the reference, GLOSSARY.md fixes the terms
src-tauri/               backend (Rust)
  src/ssh.rs             connection, authentication, host key checks, terminal channel
  src/agent.rs           SSH Agent and Pageant
  src/sftp.rs            SFTP browsing and transfers
  src/tree.rs            folder transfers, protection against path traversal
  src/edit.rs            opening remote files in local programs
  src/files.rs           one-time tokens for local files, file dialogs, drag and drop
  src/links.rs           opening links from the terminal (http and https only)
  src/store.rs           hosts, known hosts, turning the vault on and off
  src/vault/             master password vault: file format and runtime state
  src/portable.rs        data folder next to the program
  src/updater.rs         update checks; src/selfupdate.rs replaces the program
  src/system_events.rs   screen lock and sleep notifications
  src/i18n.rs            backend texts are codes with parameters
  examples/              dev_server, a test SSH agent and a fake editor for tests
  testing/               SFTP sandbox shared by the dev server and unit tests
tests/                   unit tests, end-to-end tests, footprint measurement
scripts/                 build and release scripts
docs/                    design documents
```

## Guidelines

- **Treat everything from the server as untrusted:** terminal output, file names, directory reports and error messages.
- **The backend does not trust the interface.** Local paths reach the backend only through system dialogs or drag and drop, exchanged for one-time tokens. Saved passwords are only used for the host they belong to. Keep these boundaries when adding commands.
- **No system writes.** New data goes into the `TermiPaw_Data` folder.
- **User-facing texts** go into `src/i18n/` for all eight languages; the backend returns codes and parameters. Machine translation is acceptable for the six AI-translated languages; mention it in the pull request.
- **Tests:** new behavior comes with tests, preferably at the level where it can fail (Rust unit tests for the backend, end-to-end tests for the interface).
- **Code comments** are currently mostly written in Chinese. New comments may be written in English or Chinese.
- **Commit messages** start with a type such as `feat:`, `fix:`, `docs:`, `build:` or `test:`, followed by a short summary in English.

## Licensing

By contributing, you agree that your contributions are licensed under the same terms as the project: MIT or Apache-2.0, at the user's option.
