# Changelog

All notable changes to SVault are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Shopping list, bulk receipt intake and a weekly meal planner are proposed in the
  [roadmap](docs/roadmap.md); no code has landed for them yet.

### Changed

- Repository documentation split into a user guide, architecture, API reference, deployment,
  development and roadmap.

### Fixed

- Nothing yet.

## [1.0.0] - 2026-11-02

First public release.

### Added

- Multi-house vaults with owner, admin, member and viewer roles, link invites and ownership transfer.
- Inventory items with per-house attributes, categories, places, tags and multiple barcodes.
- Batch-based stock with FIFO consumption, waste, moves, absolute counts and an immutable movement
  ledger.
- Unit conversion for mass, volume and countable units, with per-unit price history and value totals.
- Low-stock and expiry reminders, per-user read state and optional browser notifications.
- Barcode scanning with ZXing and an OpenFoodFacts fallback for unknown codes.
- Recipe OCR in the browser via Tesseract.js, AI or local recipe parsing, and "improve with AI".
- Food ideas generated from current stock and saved recipes, with a fully local fallback.
- Photo library with folders, bounding boxes, classification labels, train/val/test splits and
  YOLO/COCO export.
- OpenAI-compatible AI configuration per house or from environment variables, with presets, a
  connection test and vision-model gating.
- Installable PWA with a cached app shell and an always-network API.
- Single-container Docker deployment, Docker Compose and a TrueNAS/Dockge stack with Nginx Proxy
  Manager guidance.
- Demo seeder with fictional houses, stock, recipes and photos.
- API integration, parser, stock and dataset tests, plus smoke and visual-check scripts.

[Unreleased]: https://github.com/AtaKon/svault/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/AtaKon/svault/releases/tag/v1.0.0
