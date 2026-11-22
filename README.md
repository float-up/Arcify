<p align="center">
  <img src="assets/icons/icon-128.png" width="96" height="96" alt="Arcify">
</p>

<h1 align="center">Arcify</h1>

<p align="center"><strong>Arcify Chrome — bringing the Arc browser experience to Google Chrome.</strong></p>

<p align="center"><a href="#中文说明">中文说明</a></p>

---

Arc reimagined the browser around a sidebar and a command bar. Arcify brings both to Google Chrome as a single extension built on Chrome's native APIs — no forked browser, no account, no tracking.

## Features

### Sidebar — Arc's sidebar in Chrome's native side panel

| Arc | Arcify |
| --- | --- |
| Pinned tabs | **Pins** survive closing the tab; reopen with one click, rename freely, and see when you have navigated away from the pinned URL. |
| Folders | Nested **folders** with free mixed ordering of Pins and folders via drag and drop. |
| Favorites | A **favorites icon grid** of up to 8 sites above the Pins. |
| Today tabs | **Vertical tabs** of the current window, with one-click Clear. |
| Split View | Drag a tab onto another to create a **native Chrome split view** (Chrome 155+). |
| Peek | Links opened from a Pin open in a floating **Peek window** with its own address bar and shortcuts. |

→ [Sidebar documentation (中文)](docs/sidebar.md)

### New tab — Arc-style Spotlight

Arcify takes over ⌘T / Ctrl+T. The new tab is a single centered search box:

- Searches **frequently used sites → history → bookmarks**, in that priority, ranked by match quality and usage. Frequent sites use an ageing LFU (each open counts, scores halve every 14 days).
- **Shortcut words**: type `/git` + Space and the rest of the query only searches github.com — frequent sites, history and bookmarks — with optional in-site search. Add your own in settings.
- The caret is **in the search box as soon as the tab opens**, not in the address bar.
- Keyboard first: ↑↓ to select, ↵ to open, ⌘↵ to open in a background tab, ⇧↵ to search with your default engine right away, Esc to clear — and Esc twice to close the tab. IME-safe.
- Optional **background image**, painted in the first frame from a cached placeholder.

→ [New tab documentation (中文)](docs/newtab.md)

Plus themes shared by both (light / dark / custom colors), backups and cached favicons.

## Getting started

Arcify is plain Manifest V3 — there is no build step.

1. Clone this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the repository folder (the one containing `manifest.json`).
4. Press ⌘T / Ctrl+T for the new tab; click the toolbar icon or press ⌘B / Alt+B for the sidebar.

The first time a new tab opens, Chrome asks whether to keep the extension's new tab page — choose **Keep it**.

Requires Chrome 116 or later; split view requires Chrome 155+.

## Permissions

| Permission | Used for |
| --- | --- |
| `sidePanel` | Showing the sidebar in Chrome's side panel |
| `tabs` | Listing and managing tabs (titles, URLs, order, split view) |
| `storage` | Saving Pins, folders, shortcuts and settings locally |
| `history`, `bookmarks`, `topSites` | New tab search results |
| `favicon` | Site icons from Chrome's local favicon store (no network) |
| `search` | Searching with your default search engine |
| `webNavigation`, `scripting`, `clipboardWrite` | Peek link windows and their address bar |
| `http://*/*`, `https://*/*` (optional) | Requested only when you turn on Peek |

## Development

Requires Node.js 22+. There are no npm dependencies.

```bash
npm test          # unit tests (node:test)
npm run check     # syntax check of every script in src/
npm run verify    # both — this is what CI runs
npm run package   # dist/arcify-<version>.zip for the Chrome Web Store
```

After changing code, click **Reload** for Arcify in `chrome://extensions`.

### Repository layout

```
arcify/                       # extension root (load this folder in Chrome)
├── manifest.json
├── src/
│   ├── background/
│   │   ├── index.js          # service worker entry, imports one module per feature
│   │   ├── sidebar.js
│   │   └── newtab.js
│   ├── sidebar/              # side panel UI
│   ├── newtab/               # Spotlight new tab page (+ focus-boot.js, search.js)
│   ├── content/              # Peek scripts injected into web pages
│   └── shared/               # theme tokens, appearance engine, favicon cache
├── assets/                   # extension icons and the SVG icon sprite
├── tests/                    # sidebar/, newtab/, helpers/
├── test-pages/               # pages for manual testing
├── scripts/                  # check-syntax, package
└── docs/                     # feature documentation
```

Features talk to the service worker with namespaced messages (`newtab:open`, …); each background module answers only its own namespace.

## Privacy

Arcify stores everything locally in your browser. It sends no data anywhere, collects no analytics and has no servers. Optional site access (used by Peek) is requested only when you turn that feature on.

## Disclaimer

Arcify is an independent open-source project. It is not affiliated with, endorsed by or sponsored by The Browser Company. "Arc" is a trademark of its respective owner and is used here only to describe the inspiration for this project.

---

## 中文说明

**Arcify：把 Arc 浏览器的体验带到 Google Chrome。** 一个插件，两大能力：

- **侧边栏**：在 Chrome 原生侧边面板中实现 Arc 风格侧边栏——Pin、文件夹、顶部图标区、竖排标签、原生分屏和 Peek 链接浮窗。详见 [docs/sidebar.md](docs/sidebar.md)。
- **Spotlight 新标签页**：接管 ⌘T，页面中央只有一个输入框，按「常用网址 → 历史记录 → 书签」的优先级搜索并排序；常用网址使用带衰减的 LFU；支持 `/git` 这类快捷词把搜索限定在指定网站，快捷词可自行配置；打开新标签页时焦点直接在输入框中。详见 [docs/newtab.md](docs/newtab.md)。

### 安装

1. 克隆本仓库；
2. 打开 `chrome://extensions`，启用「开发者模式」；
3. 点击「加载已解压的扩展程序」，选择仓库根目录（`manifest.json` 所在目录）；
4. 按 ⌘T／Ctrl+T 打开新标签页；点击工具栏图标或按 ⌘B／Alt+B 打开侧边栏。第一次打开新标签页时 Chrome 会询问是否保留更改，请选择保留。

### 开发

需要 Node.js 22+，无 npm 依赖。在仓库根目录运行 `npm run verify`（语法检查 + 单元测试，CI 同样执行这条命令），`npm run package` 生成上架用的 zip。

Arcify 是独立的开源项目，与 The Browser Company 无关联；「Arc」为其所有者的商标，此处仅用于说明项目的灵感来源。
