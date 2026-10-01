# MVP Implementation Plan — mu7awir-helper

Living spec for the first shippable version. Derived from [Proposal-Description.md](./Proposal-Description.md).

## Context

The proposal describes a purpose-built "browser for a محاور": a desktop app opened side by side with a social media page, where the user searches Islamic sources (Quran, hadith, fiqh, fatwa, a personal ردود library, بصائر, الشاملة), organizes the material into a tree of discussions, and drafts Arabic responses with heavy copy/paste and voice dictation.

The repo is greenfield — only `doc/` exists, with the proposal and a 3.8 MB Telegram channel export. This document defines the stack, the data model, and a milestone path to a working MVP.

The MVP target is the **full proposal minus polish**: all seven search tools, the discussion tree, split view, autosave, the complete shortcut set, and Arabic dictation.

| Decision | Choice |
|---|---|
| Shell | **Electron** — real Chromium views per search tab; no `X-Frame-Options` problems, and a preload can inject copy affordances into third-party pages |
| Scope | Full tree + all tools, including the local مكتبة الردود index |
| Layout | **Split view from day one, stacked vertically** — search occupies the top 2/3 of the height, drafts the bottom 1/3, both full width beside the sidebar |
| Dictation | **Local whisper.cpp**, push-to-talk — free, offline, no API keys |

### Findings that shaped the plan

- **Search URLs probed live:** `tafsir.app/search?q=`, `islamqa.info/ar/search?q=`, `shamela.ws/search?q=` and `sunnah.one/?s=` all return 200 with the query reflected in the response. Only `basaer.shuounislamiya.org` still needs in-app calibration.
- **Windows Win+H cannot do Arabic.** Voice typing supports 46 languages and Arabic is not among them, so the app must supply its own dictation.
- **The Telegram export is small:** 1,480 messages, 1,039 with text, 392 distinct hashtags, median ~517 chars. It fits entirely in memory — no database, no embeddings server.

---

## Stack

- **Electron** (`WebContentsView`, Electron ≥ 30) + **TypeScript** + **React** + **electron-vite**
- **zustand** for renderer state, **MiniSearch** for the ردود index, **electron-builder** (NSIS) for packaging
- **Storage: a single JSON file**, not SQLite. The dataset is dozens of discussions and plain-text drafts; JSON means zero native modules, trivial backup, and a human-readable file the user can inspect.

> **Node version:** the machine has Node 20.17. Vite 7 requires ≥ 20.19, so pin **electron-vite 2.x / Vite 5**, or bump Node to 20.19+ and use current Vite. Pick one at scaffold time.

---

## Architecture

The React renderer owns the app chrome (sidebar, two tab bars, draft editor). Each **search tab is a separate `WebContentsView`** attached to `win.contentView` and positioned as an overlay above the search pane — the renderer measures the pane with a `ResizeObserver` and pushes the rect to main over IPC, which calls `view.setBounds()`.

The two panes are **stacked vertically**: search on top at 2/3 of the height, drafts below at 1/3, separated by a horizontal splitter the user drags up and down. Both panes span the full width to the right of the sidebar.

```
┌─────────┬───────────────────────────────────────────────┐
│ sidebar │ search tab bar                                │
│         ├───────────────────────────────────────────────┤
│ disc-   │                                          ▲    │
│ ussions │   WebContentsView overlay                │    │
│         │   (tafsir.app / sunnah.one / …)         2/3   │
│         │                                          ▼    │
│         ├══════════ draggable splitter ═════════════════┤
│         │ draft tab bar                                 │
│         ├───────────────────────────────────────────────┤
│         │   RTL draft editor (React textarea)     1/3   │
└─────────┴───────────────────────────────────────────────┘
```

The vertical stack suits the workflow: an Arabic source page and an Arabic draft are both wide, line-oriented text, so full width keeps lines readable in each, and the source sits directly above the draft it feeds.

Four consequences to design for up front:

1. **A `WebContentsView` is an OS-level overlay** — React cannot paint on top of it. Any modal, command palette, or dropdown that overlaps the search pane must first hide the active view (`setBounds` to zero or detach). Centralize this in `viewManager.hideOverlays()`.
2. **The ردود tool renders React, not a web page.** When a local-type tab is active, the view manager hides all `WebContentsView`s and the pane shows `<RududResults>`.
3. **Splitter drags resize the view, not just a div.** Because the search view is an OS overlay, dragging the horizontal splitter must push new bounds to main on every frame or the page visibly lags behind the divider. Throttle the IPC to `requestAnimationFrame` and enforce minimum heights on both panes so neither can be collapsed to nothing.
4. **Keyboard shortcuts must be registered on every `webContents`**, not just the main window, via `before-input-event` — otherwise every shortcut dies the moment focus lands inside an embedded site. This is the single easiest thing to get wrong.

Security posture for site views: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, a stock Chrome UA string on the session (some sites reject the Electron UA), a persistent session partition so logins survive restarts, and `setWindowOpenHandler` routing popups into a new app tab instead of a detached window.

### Files

```
mu7awir-helper/
├─ electron.vite.config.ts, tsconfig.json, package.json
├─ resources/
│  ├─ tools.default.json          # shipped plugin registry
│  └─ rudud.json                  # generated, gitignored
├─ scripts/build-rudud-index.mjs  # Telegram export → rudud.json
├─ src/
│  ├─ main/
│  │  ├─ index.ts                 # bootstrap, BrowserWindow
│  │  ├─ viewManager.ts           # WebContentsView lifecycle, bounds, hibernation
│  │  ├─ store.ts                 # workspace.json load / debounced atomic save
│  │  ├─ tools.ts                 # plugin registry + {q} templating
│  │  ├─ rududIndex.ts            # MiniSearch over rudud.json
│  │  ├─ dictation.ts             # model bootstrap, GPU detection, backend choice
│  │  ├─ whisperServer.ts         # resident whisper-server process
│  │  ├─ shortcuts.ts             # one keymap table, bound to all webContents
│  │  └─ ipc.ts
│  ├─ preload/
│  │  ├─ app.ts                   # contextBridge for the renderer
│  │  └─ site.ts                  # injected into search views — copy affordances
│  └─ renderer/
│     ├─ App.tsx                  # split layout + splitter
│     ├─ components/              # Sidebar, TabBar, SearchPane, DraftPane,
│     │                           # RududResults, Settings, Toast, DictationHUD
│     ├─ state/store.ts           # zustand
│     └─ lib/arabic.ts            # shared normalizer (also used by the build script)
```

---

## Data model

```ts
type Workspace = {
  version: 1
  discussions: Discussion[]
  activeDiscussionId: string | null
  settings: Settings
}

type Discussion = {
  id: string; title: string
  createdAt: string; updatedAt: string
  archived: boolean
  tabs: Tab[]                 // one ordered list; each tab carries its kind
  activeSearchTabId: string | null
  activeDraftTabId: string | null
}

type Tab = SearchTab | DraftTab

type SearchTab = {
  id: string; kind: 'search'; title: string
  toolId: string              // quran | hadith | fatwa | shamela | basaer | rudud
  query: string               // last query, for re-running and for the tab label
  url: string                 // last committed URL, restored on reopen
  createdAt: string
}

type DraftTab = {
  id: string; kind: 'draft'; title: string
  content: string             // plain text, RTL
  sources: Source[]           // accumulated attributions from copy-to-draft
  createdAt: string; updatedAt: string
}

type Source = { text: string; pageTitle: string; url: string; at: string }
```

**Persistence:** `app.getPath('userData')/workspace.json`. Debounced 500 ms, flushed on window blur and `before-quit`. Atomic write (temp file + rename) with the last 5 versions kept as `workspace.bak.N.json`. The `version` field is the migration hook.

---

## Search tool plugins

`resources/tools.default.json` ships the defaults; on first run it is copied to `userData/tools.json`, which the user can edit. A plugin is:

```json
{
  "id": "quran",
  "label": "الباحث القرآني",
  "shortcut": "Ctrl+1",
  "type": "web",
  "homeUrl": "https://tafsir.app/",
  "searchUrl": "https://tafsir.app/search?q={q}",
  "enabled": true
}
```

| id | label | homeUrl | searchUrl |
|---|---|---|---|
| `quran` | الباحث القرآني | tafsir.app | `https://tafsir.app/search?q={q}` ✅ verified |
| `hadith` | الباحث الحديثي | sunnah.one | `https://sunnah.one/?s={q}` ✅ verified |
| `fatwa` | إسلام سؤال وجواب | islamqa.info/ar | `https://islamqa.info/ar/search?q={q}` ✅ verified |
| `shamela` | المكتبة الشاملة | shamela.ws | `https://shamela.ws/search?q={q}` ✅ verified |
| `basaer` | بصائر | basaer.shuounislamiya.org | **null — calibrate in-app** |
| `fiqh` | مدونة الفقه المالكي | — | `enabled: false`, placeholder until a source is found |
| `rudud` | مكتبة الردود | — | `type: "local"` |

**When `searchUrl` is null**, the tab opens `homeUrl` and the user searches in-site — never a dead end.

**Calibration UI (ship in MVP, it is ~40 lines and makes plugins self-service):** in a search tab, "استخدم هذا الرابط للبحث" takes the current URL, finds the query text the user just typed inside it, swaps it for `{q}`, and saves it onto the plugin. This is how `basaer` gets filled in, and how any future tool is added without touching code.

---

## Copy pipeline — the core workflow

The proposal's real value is the speed of source → draft. Three mechanisms, cheapest to most useful:

1. **Hover copy button** (`preload/site.ts`). Rather than mutating the page's DOM per paragraph — which breaks site layouts and fights their own scripts — render **one floating 📋 button inside a shadow-root overlay** that follows the hovered text block (`p, li, blockquote, article, td`, min ~40 chars), positioned from `getBoundingClientRect()`. Site-agnostic, zero layout damage, survives re-renders via a debounced `mouseover` handler.
2. **`Ctrl+Shift+C` — copy selection with source.** Copies the selection plus a source line (page title + URL). Always works, even where block detection fails.
3. **`Ctrl+Enter` — copy selection straight into the active draft.** Appends the text to the draft in the pane directly below and records a `Source`. This is the shortcut that makes the split view pay off — the eye travels a short vertical hop from source to draft.

Copied text is cleaned: collapse whitespace, strip zero-width characters, **preserve Arabic diacritics** (they matter for Quran and hadith). A toast in the app chrome confirms every copy.

---

## مكتبة الردود — local index

**Build step** (`scripts/build-rudud-index.mjs`, run via `npm run build:rudud`):

- Read `doc/ChatExport_2026-09-24__JSON/result.json`, keep `type === 'message'` with non-empty text.
- Flatten `text_entities` into a plain string, preserving hashtag text and link URLs.
- **Header inheritance:** the channel's pattern is a hashtag-only message (e.g. id 4, `#أوجه_استجابة_الدعاء 👇`) followed by the body. Treat a message whose text minus hashtags/emoji is under ~10 chars as a header and attach its hashtags as topic tags to subsequent messages until the next header.
- Emit `resources/rudud.json`: `[{ id, date, tags[], text, norm }]`.

**Arabic normalizer** (`src/renderer/lib/arabic.ts`, shared by the build script and runtime — one implementation, not two): strip tashkeel `U+064B–U+0652` and `U+0670`, strip tatweel `U+0640`, fold `أإآٱ→ا`, `ى→ي`, `ة→ه`, `ؤ→و`, `ئ→ي`, strip punctuation and emoji, collapse whitespace.

**Runtime:** main loads `rudud.json` at startup into MiniSearch with the normalizer as `processTerm`, fields `['text','tags']`, `prefix: true`, `fuzzy: 0.2`, tags boosted ×3. ~1,000 documents searches in well under a millisecond. Results render as React cards — tags, date, highlighted snippet, expand, copy, copy-to-draft — in the search pane with all `WebContentsView`s hidden.

---

## Draft editor

A plain `<textarea dir="rtl">`, deliberately not a rich-text editor: the output is pasted into social media as plain text, and a textarea gives free native undo/redo, IME, and text selection.

- Arabic-friendly font stack (Noto Naskh Arabic / system), generous line-height, autosizing.
- Paste is forced to plain text.
- Character counter (useful against post length limits).
- "نسخ الرد كاملاً" (`Ctrl+Shift+A`), and an optional "append sources" toggle that emits the collected `Source[]` as a footnote block.

---

## Dictation — local whisper.cpp

Dictation is live: speech is cut into phrases at natural pauses while the user is still talking, and each phrase lands in the draft about a second after it ends (issue #5).

```
F4 ──▶ getUserMedia (mono, NS+AEC) ──▶ AudioContext @ 16 kHz ──▶ AudioWorklet tap
   ──▶ Segmenter: energy gate vs. a 3 s minimum-statistics noise floor
       closes a phrase on a 0.5 s pause, caps it at 15 s (cut at the quietest frame)
   ──▶ hand-rolled WAV bytes ──▶ IPC, one phrase at a time
   ──▶ whisper-server (resident; CUDA build if there is an NVIDIA GPU, else CPU)
       └─ fallback: whisper-cli per phrase
   ──▶ insert at the cursor, strictly in spoken order
```

Encoding the WAV in the renderer (~40 lines) avoids bundling **ffmpeg**, which would add ~80 MB and a licensing question for no benefit.

**Why a resident server and a GPU.** whisper-cli reloads the 574 MB model on every call, and on CPU large-v3-turbo runs *slower* than real time: 46 s for a 35 s clip on a 6-core i5, which is what made the original push-to-talk feel useless and let its flat 180 s timeout kill long recordings. `whisper-server` keeps the model loaded, and the official CUDA build does a 12 s phrase in ~0.3 s on an RTX 3060 Ti (1.4 s for the first, which includes loading the model). The server is started on the first F4 press, stopped after 15 idle minutes and on quit, and started with `-nc` so requests never share hidden state; continuity comes from passing the last ~200 characters as the prompt. The CUDA build is compiled for sm_52 only, so a newer card JIT-compiles its kernels on the very first run (~15 s, then cached by the driver).

**Bootstrap, on first use rather than in the installer** — keeps the download out of the app bundle:

- Download `whisper-bin-x64.zip` from the whisper.cpp releases and `ggml-large-v3-turbo-q5_0.bin` (~574 MB) from the HuggingFace `ggerganov/whisper.cpp` repo, both into `userData`, with a progress UI.
- When `nvidia-smi` reports a card, also download `whisper-cublas-12.4.0-bin-x64.zip` (443 MB, CUDA runtime included, checksum pinned) into `userData/whisper/cuda`. Existing installs get a button for it in Settings. If the CUDA server will not start, dictation falls back to the CPU server and Settings says why.
- Settings let the user point at an existing binary or model path instead, and swap the model (`large-v3-turbo` ⇄ `large-v3` ⇄ `medium-q5_0`) to trade speed for accuracy.

**UX:** hold `F4` to talk and release to finish, or tap `F4` for hands-free dictation and press it again to stop. While recording, the HUD shows the level meter, the number of phrases still being transcribed and — on a GPU only, where it is nearly free — a live preview of the phrase being spoken. After the microphone closes, «جارٍ إنهاء التفريغ…» stays up until the last phrase is in. `Esc` cancels: the open phrase and anything not yet inserted are dropped, and text already inserted stays. A transcript consisting only of a subtitle credit whisper hallucinates over noise («ترجمة نانسي قنقر») is discarded.

**Expectation setting:** published Arabic WER is ~37% for large-v3 and ~40% for turbo on hard dialectal benchmarks. Clear MSA from a single speaker on a decent mic does far better, but dictation is a drafting aid the user edits afterward, not a transcription service. The swappable model is the mitigation.

---

## Keyboard shortcuts

One declarative table in `src/main/shortcuts.ts`, bound to **every** `webContents` via `before-input-event`, overridable from settings. No `globalShortcut` — the app should never steal keys OS-wide.

| Action | Key |
|---|---|
| New discussion (inline name prompt) | `Ctrl+N` |
| Rename discussion / rename active tab | `Ctrl+Shift+N` / `F2` |
| New search tab with tool N | `Ctrl+1` … `Ctrl+7` |
| New response draft | `Ctrl+D` |
| Next / previous discussion | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Next / prev search tab | `Alt+→` / `Alt+←` |
| First / last search tab | `Alt+Home` / `Alt+End` |
| Next / prev draft tab | `Ctrl+Alt+→` / `Ctrl+Alt+←` |
| First / last draft tab | `Ctrl+Alt+Home` / `Ctrl+Alt+End` |
| Close tab / archive discussion | `Ctrl+W` / `Ctrl+E` |
| Copy selection + source | `Ctrl+Shift+C` |
| Copy selection into active draft | `Ctrl+Enter` |
| Copy whole draft | `Ctrl+Shift+A` |
| Find in page (Electron `findInPage`) | `Ctrl+F` |
| Dictation | hold `F4` (push-to-talk), or tap `F4` to start and stop hands-free |

`Ctrl+F` matters more than it looks: embedded views have no Chrome find bar, so without it the search pane loses a function the user expects from a browser.

When a new search tab is opened with `Ctrl+1..7` and text is selected in the current search view, prefill the query prompt with that selection.

---

## Milestones

| # | Scope | Est. |
|---|---|---|
| **M0** | electron-vite + React + TS scaffold, window, empty split layout, `store.ts` with autosave round-trip | ½ d |
| **M1** | Sidebar discussion CRUD, stacked search/draft panes with their own tab bars, horizontal splitter (drag up/down, persisted ratio, min heights), rename/archive/delete | 1 d |
| **M2** | `viewManager`, `WebContentsView` per search tab, bounds sync, tool registry, new-search prompt, back/forward/reload/`findInPage`, calibration UI | 1–1.5 d |
| **M3** | `preload/site.ts` hover copy button, `Ctrl+Shift+C`, `Ctrl+Enter` → draft, toasts | ½–1 d |
| **M4** | RTL draft editor, autosave, copy-all, source footnotes | ½ d |
| **M5** | `build-rudud-index.mjs`, normalizer, MiniSearch, results UI, copy paths | 1 d |
| **M6** | Dictation: capture → WAV, binary/model bootstrap with progress, push-to-talk, insert at cursor | 1 d |
| **M7** | Full keymap incl. inside webviews, settings panel, electron-builder NSIS packaging | ½–1 d |

**~6–8 focused days.** M0–M4 alone is already a usable tool; M5 and M6 are independent and can be reordered.

---

## Verification

**Automated (vitest + node):**

- `npm run build:rudud` asserts ≥ 1,000 indexed documents and prints a sample record.
- Normalizer unit tests: tashkeel stripping, alef/ya/ta-marbuta folding, idempotence.
- Index recall test: searching `الوسواس القهري` returns the messages tagged `#الوسواس_القهري_وعلاجه_مكثف` and `#علاج_الوسواس_القهري_للمبتدئين`; `الصبر` returns non-zero hits.
- Store round-trip: write a workspace with 3 discussions and mixed tabs, reload, deep-equal; simulate a crash mid-write and confirm the `.bak` recovers.

**Manual E2E (the acceptance run, `npm run dev`):**

1. `Ctrl+N` → new discussion «حوار الإلحاد».
2. `Ctrl+1` → search `الصبر` on tafsir.app; the page renders in the top 2/3 pane.
3. Hover a paragraph → 📋 copies it; `Ctrl+F` finds a word in the page.
4. `Ctrl+D` → new draft in the bottom pane; select text in the search pane above → `Ctrl+Enter` → it lands in the draft with its source.
5. `Ctrl+2` → sunnah.one hadith search; `Alt+←`/`Alt+→` move between the two search tabs, drafts unaffected.
6. `Ctrl+7` → مكتبة الردود, search `الوسواس`, copy a result into the draft.
7. Hold `F4`, dictate an Arabic sentence, release → text appears at the cursor.
8. `Ctrl+Shift+A` → paste into Notepad, verify RTL plain text and sources.
9. Quit and relaunch → discussions, tabs, URLs, drafts, and splitter ratio all restored.
10. Resize the window, collapse the sidebar, drag the splitter up and down to the extremes → the embedded view tracks the top pane's height at every position and never spills over the draft pane; open the settings modal → the view hides instead of being painted over.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `WebContentsView` occludes React overlays | Central `hideOverlays()` — every modal/palette hides views before opening |
| Site markup changes break block detection | Generic hover-follow button on any text-bearing block, with selection-copy as the always-works fallback |
| `basaer` search URL unknown | Calibration UI; fall back to `homeUrl` and in-site search — never blocking |
| Whisper Arabic accuracy | Swappable model, push-to-talk on short utterances, treated as a drafting aid |
| Sites reject the Electron UA | Stock Chrome UA on the session |
| Memory growth from many live views | Cap ~8 live `WebContentsView`s; hibernate older tabs to `{url}` and recreate on activation |
| Node 20.17 vs Vite 7 engine floor | Pin Vite 5 via electron-vite 2.x, or bump Node — decide at M0 |

## Implementation notes (M0–M7)

Findings from building the milestones that the plan could not have predicted.

- **Toolchain pinned to Node 20.17.** electron-vite 5, Electron 44, `@vitejs/plugin-react` 5+
  and Vitest 5 all require Node ≥ 20.19 or ≥ 22.12. The stack is therefore Electron 38 +
  electron-vite 3 + Vite 6 + Vitest 3, which needs no system change. `winget upgrade
  OpenJS.NodeJS.20` (20.20.2 is available) unlocks the current generation when wanted.
- **CommonJS output, not ESM.** Sandboxed preloads must be CJS, and the site preload
  injected into third-party pages has to stay sandboxed.
- **Electron does not emit `found-in-page` for a `WebContentsView`.** Verified against
  Electron 38: the identical call on a BrowserWindow's own webContents emits, the view's
  never does, even though matches are highlighted correctly. The find bar therefore counts
  matches in-page and tracks the active ordinal itself; Chromium still does the
  highlighting and the next/previous stepping.
- **Chromium throttles `requestAnimationFrame` to a standstill in a hidden window.** This
  stalls both the view bounds sync and the in-page hover overlay. The bounds sync now
  schedules a 32 ms timer alongside the rAF, and the smoke run shows its window.
- **`position: fixed` blockifies `inline-flex` to `flex`** — relevant when asserting on the
  hover button's computed style.
- **Preventing a key-down makes Chromium drop the matching key-up.** Push-to-talk broke
  the moment shortcut matching moved into `before-input-event`: F4's key-down was being
  `preventDefault()`ed, so the key-up never arrived and recording never stopped. The
  dictation key is now matched without preventing it.
- **A hover affordance must not be throttled with `requestAnimationFrame`.** Chromium
  freezes rAF whenever the window is unfocused or occluded, which would strand the copy
  button mid-page; it uses a timer instead.
- **A bare hashtag in مكتبة الردود is a topic filter, not a word search.** Tokenising
  `#تشجيع_على_الصبر_على_الأذى` split it into its component words and AND-matched common
  ones like «على», so clicking a tag chip returned noise.
- **electron-builder needs `@noble/hashes` pinned to 1.8.0** (an npm override):
  `app-builder-lib` requires it as CommonJS, but v2 is ESM-only and the packaging step
  dies on startup.
- **Verification**: 158 unit tests plus `npm run smoke`, a 64-step acceptance run that
  launches the real app against a throwaway user-data directory, drives the DOM and the
  embedded pages, and checks the clipboard and the file on disk. It is hermetic by default
  (local `data:` URLs); `MU7_SMOKE_NET=1` adds a live-site run, and `MU7_SMOKE_SHOT=<path>`
  captures screenshots. `npm run verify` chains typecheck, tests, build and smoke, and the
  same suite is run against the packaged build to prove `process.resourcesPath` resolves.
- **Not verified**: whisper transcription accuracy on real Arabic speech, and the live
  ~600MB asset download. Both need the model and a microphone. Everything up to the
  binary — capture, resampling, WAV encoding, IPC, temp files, parsing — is covered.

## Out of scope for the MVP

Cross-discussion search / command palette (`Ctrl+K`), alternate layouts (tabs-only, or side-by-side instead of stacked), cloud sync, the مدونة الفقه المالكي source, rich-text drafts, macOS/Linux packaging, and injecting copy buttons into PDF viewers.
