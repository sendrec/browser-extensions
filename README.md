# SendRec Browser Extensions

This repository contains the SendRec browser extensions for Chrome/Chromium and Firefox.

Both extensions let you record your screen and upload recordings directly to [SendRec](https://app.sendrec.eu) or a self-hosted SendRec instance.

[![Get the Add-on](https://blog.mozilla.org/addons/files/2015/11/get-the-addon.png)](https://addons.mozilla.org/addon/sendrec-screen-recorder)

## Repository Contents

| Folder | Purpose |
| --- | --- |
| `sendrec-chrome-extension/` | Chrome / Chromium extension built on Manifest V3 |
| `sendrec-firefox-extension/` | Firefox extension built on Manifest V2 with Gecko settings |

## Shared Capabilities

- Screen recording
- Direct upload to SendRec using presigned URLs
- Support for hosted and self-hosted SendRec servers
- Configurable server URL and user credentials
- Popup UI for recording controls
- Options page for setup and defaults

## Browser Differences

| Area | Chrome / Chromium | Firefox |
| --- | --- | --- |
| Minimum version | Chrome 116 | Firefox 140 |
| Manifest | MV3 | MV2 |
| Background model | Service worker + offscreen document | Background script |
| Install flow | Load unpacked in Developer Mode | Load temporary add-on or install unsigned `.xpi` in Developer Edition / ESR / Nightly |
| Tab capture | Uses `tabCapture` and `offscreen` permissions | Uses Firefox-compatible background capture flow |

## Quick Start

### Chrome / Chromium

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `sendrec-chrome-extension` folder
5. Open the extension settings and configure:
   - Server URL
   - Email
   - Password

### Firefox

Temporary install:

1. Open `about:debugging`
2. Select **This Firefox**
3. Click **Load Temporary Add-on...**
4. Choose `sendrec-firefox-extension/manifest.json`

Permanent local install for unsigned builds:

1. Use Firefox Developer Edition, ESR, or Nightly
2. Set `xpinstall.signatures.required = false` in `about:config`
3. Package `sendrec-firefox-extension` as an `.xpi`
4. Install it from `about:addons`

## Configuration

Each extension expects the same core settings:

- **Server URL**: SendRec cloud or your self-hosted instance
- **Email**: SendRec account email
- **Password**: Used to obtain a session token
- **Default recording options**: Source, webcam, microphone, and system audio preferences

The password is not stored directly. The extensions store a session token locally and refresh it when needed.

## Architecture Overview

### Chrome Extension

- `background/` handles state, uploads, and extension lifecycle logic
- `offscreen/` hosts the recording logic required by MV3
- `popup/` contains the recording controls UI
- `options/` contains the settings UI

### Firefox Extension

- `background/` handles recording, upload, and authentication
- `popup/` contains the recording controls UI
- `options/` contains the settings UI
- `shared/` contains shared theme logic

## Development Notes

- There is no build step in this repository; both extensions are loaded directly from source.
- Version numbers and browser permissions are defined in each extension's `manifest.json`.
- Browser-specific behavior should be implemented inside the respective extension folder rather than trying to fully unify the code paths.

## Extension READMEs

For browser-specific details, see:

- [sendrec-chrome-extension/README.md](./sendrec-chrome-extension/README.md)
- [sendrec-firefox-extension/README.md](./sendrec-firefox-extension/README.md)