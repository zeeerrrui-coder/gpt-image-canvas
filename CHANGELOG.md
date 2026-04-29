# Changelog

## v0.1.0 - 2026-04-29

First usable release focused on durable image storage, provider compatibility, and smoother canvas workflows.

### Added

- Tencent Cloud COS backup for AI-generated images.
- In-app cloud storage settings for COS `SecretId`, `SecretKey`, bucket, region, and key prefix.
- Local + COS dual-write flow for new generated images when COS is enabled.
- COS test upload/delete validation before saving cloud storage settings.
- Cloud metadata on generated assets, including upload status, object key, upload time, and last error.
- Local-first asset reads with COS fallback and local backfill when the local file is missing.
- Compatibility for PackyCode / `gpt-image` style image response formats.

### Changed

- Generated images remain saved locally even when cloud upload fails.
- Cloud upload failures are shown in the UI without failing the generation result.
- Project loading now falls back to a blank canvas if an old or damaged project row cannot be read.
- Project snapshot save limit increased to reduce autosave failures for larger canvases.
- Docker defaults keep SQLite in `DELETE` journal mode with `EXCLUSIVE` locking for bind-mounted data.
- Cloud storage secrets are masked in GET responses and are not echoed back in full.

### Upgrade Notes

- Back up `data/` before upgrading from earlier builds.
- Rebuild the Docker image after upgrading so the web app and API routes stay in sync.
- Do not run Docker and `pnpm dev` against the same `data/` directory at the same time.
- COS settings are stored locally in SQLite. If the database is reset, re-enter the COS SecretKey in the cloud storage dialog.
