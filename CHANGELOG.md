# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.16] - 2026-06-25

### Added

- Console viewer: capture `console.log`/`warn`/`error` calls with batching (500ms / 50 log threshold)
- Dashboard Console view with level filters (ALL / LOG / WARN / ERROR), platform badges (iOS/Android), app filter dropdown, search, and auto-scroll
- Copy-to-clipboard on console log entries
- `patchConsole` option in public API and TypeScript types (`index.d.ts`)

### Fixed

- Missing closing brace in `renderLogs()` inline JS function that caused a syntax error
- Removed duplicate "Server API" section from README

### Chore

- Added dev scaffolding scripts to `.gitignore`

## [0.2.15] - 2026-06-24

### Added

- Resizable request/detail panes in the dashboard

## [0.2.14] - 2026-06-23

### Added

- Dashboard port switching and ADB auto-connect opt-in
- Simplified README quick start guide

## [0.2.13] - 2026-06-23

### Added

- Copy path action for requests

## [0.2.12] - 2026-06-22

### Added

- Searchable, collapsible JSON response body viewer
- Moved README assets out of npm package

### Fixed

- JSON search focus and scroll behavior

## [0.2.11] - 2026-06-22

### Added

- Filter Metro and inspector noise from captured requests

### Changed

- Improved README visuals and device setup instructions

## [0.2.10] - 2026-06-22

### Added

- Live RN app registration on the dashboard
- cURL import/export tools and copy actions

### Fixed

- Hardened RN inspector host detection and clarified device visibility
- Fixed CLI bin path

## [0.2.9] - 2026-06-22

### Added

- Repository metadata and MIT license

### Fixed

- Initial release cleanup

## [0.2.0 - 0.2.8] - 2026-06-21

### Added

- Initial implementation of React Native NetInspect
- Proxy server with request/response capture
- WebSocket-based live dashboard
- Fetch and XHR patching for network interception
- iOS simulator and Android emulator/device detection
- ADB reverse proxy setup
- Resizable layout, dark theme, and responsive dashboard
