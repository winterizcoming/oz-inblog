# Security Policy

## Supported version

Security fixes are provided for the latest published prerelease only.

## Reporting

Do not publish credentials, private manuscripts, session files, or reproduction data in a public issue. Open a minimal GitHub issue that contains no private data and ask for a private reporting channel.

## Local security model

- The HTTP server binds to `127.0.0.1` only.
- Session directories are created with mode `0700`; session files are written with mode `0600`.
- Authentication files and environment variable values are not copied into the application.
- Debug traces are disabled by default and remain under the local data directory when enabled.
- oz-inblog does not expose Supabase or another remote session store.
