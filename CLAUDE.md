# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Open Claude in Chrome** — a clean-room reimplementation of Anthropic's "Claude in Chrome" browser extension that removes the 58-domain blocklist and works on any Chromium browser (Chrome, Edge, Brave, Arc, Opera, Vivaldi). It exposes the same 18 MCP tools and is meant to match the official extension's behavior/output formats exactly. MIT licensed.

There is **no build step** — every file is plain JavaScript (ES modules in `host/`, classic scripts in `extension/`).

## Architecture

The data path is a 4-hop bridge:

```
Claude Code  <--stdio MCP-->  mcp-server.js  <--TCP :18765-->  native-host.js  <--native messaging-->  background.js (extension)  <--CDP-->  Browser tab
```

Three components, each a distinct process boundary:

1. **`extension/`** — Manifest V3 extension. `background.js` (service worker) does all browser automation via `chrome.debugger` (CDP) and `chrome.tabs`/`chrome.tabGroups`; `content.js` runs in-page for the accessibility tree, text extraction, element `find`, form input, and ref→coordinate resolution.
2. **`host/mcp-server.js`** — Node process launched by Claude Code over stdio. Declares all 18 tools (zod schemas) and forwards each call to the extension. Owns the multi-session multiplexing logic (see below).
3. **`host/native-host.js`** — Launched by the *browser* (via `connectNative`) when the extension starts. Pure bridge: translates Chrome's native-messaging framing (4-byte LE length prefix + JSON over stdin/stdout) ⇄ newline-delimited JSON over TCP to the MCP server.

### Wire protocol (between mcp-server ⇄ native-host, both directions over TCP)
Newline-delimited JSON. Request: `{id, type:"tool_request", tool, args}`. Response: `{id, type:"tool_response", result}` or `{id, type:"tool_error", error}`. `{type:"heartbeat"}` messages are ignored.

### Multi-session multiplexing (mcp-server.js)
Multiple Claude Code sessions share one browser. The first server to bind TCP `:18765` is **PRIMARY** (owns the native-host socket); later servers get `EADDRINUSE` and become **CLIENT**, connecting to the primary as a TCP client. The primary classifies each inbound socket by waiting ~500ms: a client sends `client_hello` immediately, a native host stays silent (it doesn't send data on connect). Client requests are forwarded to the native host with a prefixed id (`c<clientId>_<id>`) and routed back via `clientRequestMap`. Only one native host (one browser profile) may connect; a second is rejected.

When editing connection/lifecycle code, mind the resiliency machinery: pidfiles in `os.tmpdir()`, native-host auto-reconnect (60 attempts @ 500ms then exit), and the 5s "resend pending requests" grace window on native-host disconnect.

## Critical Invariants

These are load-bearing — past commits fixed subtle bugs here. Don't regress them.

- **`deviceScaleFactor: 1` is forced** via `Emulation.setDeviceMetricsOverride` in `ensureAttached` (background.js). Without it, Retina screenshots come back 2× and every click coordinate is wrong. Screenshots are captured in CSS pixels to match `Input.dispatchMouseEvent`'s coordinate space.
- **Screenshots are JPEG-only**, quality 55 (drops to 30 if >500KB base64), capped, and the store keeps only the last 10. This is deliberate to control MCP payload size — don't switch to PNG or raise quality casually.
- **Tool output formats must match the official Claude in Chrome** (`read_page`, screenshot response strings, etc.). Several commits exist solely to achieve parity.
- **`isInGroup()` always re-queries live `chrome.tabs` state** rather than trusting in-memory `tabGroupTabs`, because the MV3 service worker can be killed and restarted mid-session (state recovered via `recoverTabGroupState()` and the `keepalive` alarm).
- Naming: the native messaging host id is `com.anthropic.open_claude_in_chrome`. The default port is `18765`, overridable via `~/.config/open-claude-in-chrome/config.json` (`{"port": ...}`) — change it in **both** `mcp-server.js` and `native-host.js` if hardcoding anywhere.

## Stubbed Tools

All 18 tools are declared, but these return "not supported" stubs in `background.js`: `gif_creator`, `shortcuts_list`, `shortcuts_execute`, `switch_browser`, and `upload_image` (partial). `update_plan` is auto-approved (no permission system). Real implementations: `tabs_context_mcp`, `tabs_create_mcp`, `navigate`, `computer` (13 actions), `read_page`, `get_page_text`, `find`, `form_input`, `javascript_tool`, `read_console_messages`, `read_network_requests`, `resize_window`.

## Setup / Development Workflow

```bash
cd host && npm install && cd ..        # install MCP SDK (only dependency)
./install.sh <extension-id> [more-ids] # register native host (one id per browser)
claude mcp add open-claude-in-chrome -- node "$(pwd)/host/mcp-server.js"
```

`install.sh` generates `host/native-host-wrapper.sh` (gitignored — it embeds the absolute `node` path) and writes the native-messaging manifest into each detected browser's `NativeMessagingHosts/` dir (macOS + Linux only; Windows is manual).

### After changing code (no rebuild — just reload the right layer)

| Changed file | Action |
|---|---|
| `extension/*.js` or `manifest.json` | Reload extension in `chrome://extensions` (reload icon) |
| `host/mcp-server.js` | `pkill -f "node.*mcp-server"`, then `/mcp` in Claude Code |
| `host/native-host.js` | Restart the browser (close **all** windows) — it's relaunched by the browser |
| `install.sh` / host name | Re-run `./install.sh <id>`, restart browser, re-add MCP |

### Debugging
- Service worker logs: `chrome://extensions` → "Inspect views: service worker".
- MCP server logs go to **stderr** (`process.stderr.write`) — visible in Claude Code's MCP logs.
- "Browser extension is not connected" = MCP server up but native host hasn't connected. Open a page to wake the service worker; check `host/native-host-wrapper.sh` exists.
- Stale-server issues after reconnect: `pkill -f "node.*mcp-server"` then `/mcp` — a fresh server rebinds the port.

### Manual verification
There are no automated tests. `test-prompt.md` contains a manual end-to-end test script. The canonical smoke test: ask Claude to "Navigate to reddit.com and take a screenshot" (reddit is on the official blocklist, so success proves the unblocking works).
