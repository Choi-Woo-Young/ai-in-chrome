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
- **`isInGroup()` always re-queries live `chrome.tabs` state** rather than trusting in-memory `tabGroupTabs`, because the MV3 service worker can be killed and restarted mid-session (state recovered via `recoverTabGroupState()` and the `keepalive` alarm). The agent's tab group is titled by the `GROUP_TITLE` constant (`"Claude"`) — `isInGroup` recovery and `recoverTabGroupState` match on it, so changing the title means changing the constant (one place).
- **Two ways the agent's tab group gets its first tab.** CLI/terminal use has no "current tab", so `ensureTabGroup(true)` opens a **new window** (`chrome.windows.create`) and groups it. The side panel instead calls `adoptTabIntoGroup(tabId)` to fold the user's **current active tab into the group in place** (same window, no new window) — this mirrors the official extension's "main tab = where the side panel opened". Don't make `ensureTabGroup` adopt the active tab; keep the two paths separate.
- Naming: the native messaging host id is `com.anthropic.open_claude_in_chrome`. The default port is `18765`, overridable via `~/.config/open-claude-in-chrome/config.json` (`{"port": ...}`) — change it in **both** `mcp-server.js` and `native-host.js` if hardcoding anywhere.

## Stubbed Tools

All 18 tools are declared, but these return "not supported" stubs in `background.js`: `gif_creator`, `shortcuts_list`, `shortcuts_execute`, `switch_browser`, and `upload_image` (partial). Real implementations: `tabs_context_mcp`, `tabs_create_mcp`, `navigate`, `computer` (13 actions), `read_page`, `get_page_text`, `find`, `form_input`, `javascript_tool`, `read_console_messages`, `read_network_requests`, `resize_window`. (`update_plan` is no longer a pure no-op — it now records approved domains for the air-gap approval gate; see below.)

## Air-gap customizations (live in the code — change runtime behavior)

This repo is also an **air-gapped enterprise fork**. The full design/decisions live in `custom/` (the source of truth is `custom/05-확정-아키텍처-opencode-및-PoC.md`; `custom/검토-종합-보고서.md` is the consolidated overview). The target runs **opencode** (not Claude Code) as the agent, connected to a self-hosted vLLM (gpt-oss / Qwen3) over the OpenAI API. `custom/poc/` holds a working opencode config (`opencode.json` registers this MCP server + a local ollama provider; `AGENTS.md` enforces a text-first policy).

Three security patches are **already merged and active** — they intentionally diverge from upstream/official behavior. If a tool returns an unexpected "미승인"/"차단됨" message, this is why:

- **Approval gate + auto-run** (`background.js`, `ENFORCE_APPROVAL = true`): `update_plan(domains)` records hosts into the `approvedDomains` set. **Write tools are blocked on unapproved domains** and return a "미승인" message instead of executing — `navigate` checks the *target* host; `computer` (only write actions: clicks/`type`/`key`/`left_click_drag`), `form_input`, and `javascript_tool` check the tab's *current* host via `writeGate(tabId)`. **Read tools are always allowed** (`read_page`, `get_page_text`, `find`, screenshot, etc.). So a fresh `navigate` to a new domain fails until `update_plan` approves it; once approved the domain auto-runs (no re-approval). Set `ENFORCE_APPROVAL = false` to disable.
- **Domain blocklist hook** (`background.js`, `BLOCKED_HOSTS = []`): empty by default (blocks nothing — the feature is wired but the list is intentionally empty). `navigate` and `writeGate` reject any host in the list (subdomain-aware). Add hosts to enforce.
- **Audit logging** (`mcp-server.js`, in `callTool`): every tool call is appended as one JSON line to `~/.config/open-claude-in-chrome/logs/audit-YYYY-MM-DD.jsonl` (mode `0600`), capturing tool, arg summary (incl. `javascript_tool` source), result snippet, and timing. The MCP server is the chokepoint, so blocked/denied outcomes are logged too.

`javascript_tool` is deliberately **not** restricted (full arbitrary JS retained) beyond the approval gate + audit. Local TCP auth was intentionally skipped (target is 1-user-per-VDI).

A **19th tool — `describe_screen(tabId, question)`** (mcp-server.js) — is added for the hybrid-vision pattern: the text "brain" model (Qwen3) stays in charge and calls this only when the accessibility tree (`read_page`/`find`) is insufficient. The MCP server captures a screenshot, sends it to a vision model (`OCIC_VL_ENDPOINT`/`OCIC_VL_MODEL`, default ollama `qwen2.5vl:7b`; point at vLLM in the closed network), and returns **text only** — so the image never enters the brain's context and any text model can use it. It's read-only (not approval-gated) but is audited. PoC validated on Mac (M4 Pro 48GB) with opencode as the agent.

## Side panel (browser chat UI)

`extension/sidepanel.{html,js,css}` add a **second entry point** alongside the opencode CLI: an in-browser chat panel for non-technical users. It is a **thin client** — it does **not** call MCP tools or the native host. It talks over HTTP to a background `opencode serve` (default `127.0.0.1:7777`, streamed via SSE `/event`); opencode is the brain and calls the MCP tools, so every security gate, audit log, and tab rule above applies unchanged. Manifest gains the `sidePanel` permission + `side_panel.default_path`; `background.js` opens it via `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true})`.

- **Requires** `opencode serve --hostname 127.0.0.1 --port 7777 --cors chrome-extension://<id>` running, using `custom/poc/opencode.json` (provider + this MCP server + `AGENTS.md`). After editing `opencode.json`/`AGENTS.md`, restart `opencode serve`; after editing `sidepanel.*` or `background.js`, reload the extension.
- **Model picker** reads `GET /config` `provider.{id}.models`. The sidebar classifies each model: **vision** if `modalities.input` includes `"image"` (or `attachment:true`), **tool-capable** if `tool_call !== false`. Attaching an image auto-switches to a vision model (preferring one that is *also* tool-capable) and restores the prior model on the next text-only turn.
- **Image attachment** (drag / paste / file-picker) → data URL → opencode `file` parts. For tool-capable vision models, tools stay **enabled** (vision + tool-calling in one turn); analysis-only vision models get `tools:{"*":false}`. Image turns use an image-first prompt so the model describes the attachment instead of re-fetching the page it depicts.
- **Current-tab operation**: on a tool-capable send, the sidebar calls the `sidepanel_adopt_active_tab` message → `adoptTabIntoGroup` (see Invariants) so the agent acts in the tab the user is viewing. Other `sidepanel_*` handlers in `background.js`: `sidepanel_get_active_tab` (read-only context), `sidepanel_approve_domain` / `sidepanel_set_auto_approve` (drive the approval gate from the UI's "묻지 않고 실행" toggle).
- **Vision serving** is OpenAI-`/v1` `image_url` on both targets, differing only by `opencode.json`/env: Mac = ollama, internal = vLLM Qwen3-VL (`--tool-call-parser qwen3_xml --enable-auto-tool-choice`). **Gotcha (Mac/ollama):** a 30B VL loaded at its stock 262144 context OOMs Metal and returns empty 200s (`Insufficient Memory` in `~/.ollama/logs/server.log`); the PoC uses a derived model `qwen3-vl:browser` (`ollama create … PARAMETER num_ctx 65536`). vLLM caps context with `--max-model-len`, so this gotcha is Mac-only.

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
| `extension/*.js` (incl. `sidepanel.js`) or `manifest.json` | Reload extension in `chrome://extensions` (reload icon) |
| `host/mcp-server.js` | `pkill -f "node.*mcp-server"`, then `/mcp` in Claude Code |
| `host/native-host.js` | Restart the browser (close **all** windows) — it's relaunched by the browser |
| `custom/poc/opencode.json` or `AGENTS.md` | Restart `opencode serve` (it reads them at startup / per session) |
| `install.sh` / host name | Re-run `./install.sh <id>`, restart browser, re-add MCP |

### Debugging
- Service worker logs: `chrome://extensions` → "Inspect views: service worker".
- MCP server logs go to **stderr** (`process.stderr.write`) — visible in Claude Code's MCP logs.
- "Browser extension is not connected" = MCP server up but native host hasn't connected. Open a page to wake the service worker; check `host/native-host-wrapper.sh` exists.
- Stale-server issues after reconnect: `pkill -f "node.*mcp-server"` then `/mcp` — a fresh server rebinds the port.

### Manual verification
There are no automated tests. `test-prompt.md` contains a manual end-to-end test script. The canonical smoke test: ask Claude to "Navigate to reddit.com and take a screenshot" (reddit is on the official blocklist, so success proves the unblocking works).
