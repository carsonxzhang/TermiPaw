# Security Policy

TermiPaw handles SSH credentials, so security reports are welcome and taken seriously.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability**. Do not open a public issue.

Include the affected version, the steps to reproduce, and the impact you expect. Reports may be written in English or Chinese.

This is a personal open source project with no bug bounty. I will reply as soon as I can, and I will credit you in the release notes unless you prefer otherwise.

## Supported versions

Only the latest release receives security fixes.

## Security audits

TermiPaw has not had a third-party security audit.

## Scope

The design and known limits are documented here:

- [Master password vault](docs/VAULT.md)
- [Online updates](docs/UPDATER.md)
- [Portable design](docs/PORTABLE.md)

## Known issues in dependencies

- **RUSTSEC-2023-0071 (Marvin attack on `rsa`):** no fixed version exists yet, and the SSH library needs `rsa` for RSA keys. Exploiting it requires timing many private-key operations; TermiPaw signs once per login with the user's key, so exposure is small. Removing RSA support would make servers that only accept RSA keys unreachable. The advisory is ignored in `src-tauri/.cargo/audit.toml` until a fix is released.
- The SSH library currently depends on pre-release versions of `rsa` and `ssh-key`. They are updated as stable versions become available.
