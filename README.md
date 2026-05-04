# Claude Memory UI

A visualization dashboard for Claude Code's memory system. Parses your `MEMORY.md` index topology, displays files by type, supports in-browser editing, and tracks token budgets.

## Features

- **Index Topology**: Parses `MEMORY.md` as a tree root — sections become collapsible groups, linked files become clickable leaves
- **Type Detection**: Reads YAML `frontmatter.type` (user/feedback/reference/project) and colors them distinctly
- **Live Editing**: Edit any file in the browser, `Cmd+S` to save (auto-creates `.bak` backup)
- **Token Budget**: Estimates tokens per file and total, shows breakdown by type and heaviest files
- **Duplicate Detection**: Finds title-similar files, multi-referenced files, and description overlaps
- **Auto-Refresh**: Polls for changes every 3s, updates the UI when Claude Code modifies memory files
- **Auto-Discovery**: Scans `~/.claude/projects/` for all projects with memory directories — no hardcoded paths
- **Static Mode**: Open `index.html` directly in a browser and load from a JSON export — no server needed

## Quick Start (Local)

```bash
git clone https://github.com/braveheartforeverever-coder/claude-memory-ui.git
cd claude-memory-ui
npm install
node server.js
```

Open http://localhost:3456

## Quick Start (Cloud / Static)

No Node.js needed. Open `public/index.html` in any browser and load a JSON export:

```bash
# 1. Export from your local server
curl http://localhost:3456/api/export > memory.json

# 2. Open index.html in browser, drag & drop memory.json
open public/index.html
```

Or deploy `public/` to any static host (Vercel, Netlify, GitHub Pages).

## How It Works

Claude Code stores memory in `~/.claude/projects/<encoded-path>/memory/`. Each project's `MEMORY.md` is the index file that references other `.md` files via `[text](./file.md)` links.

This tool:
1. Auto-discovers all projects under `~/.claude/projects/`
2. Selects the project with the most memory files
3. Parses `MEMORY.md` to reconstruct the index tree
4. Reads frontmatter (`type`, `name`, `description`) from each file
5. Renders a tree sidebar, editor, and analysis panel

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `PORT` | `3456` | Server port |
| `MEMORY_DIR` | auto-discover | Override memory directory path |

## Architecture

```
claude-memory-ui/
├── server.js          # Express API: scan, parse, save, detect changes
├── public/index.html  # Single-page app: tree view, editor, analysis
├── package.json
└── README.md
```

No build step. No framework. Just `node server.js` and open the browser.

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/files` | GET | All files with metadata, token counts, index topology |
| `/api/changes` | GET | Lightweight fingerprint for change detection |
| `/api/file/:name` | GET | Single file content |
| `/api/save` | POST | Save file content back to disk |
| `/api/projects` | GET | List discovered Claude Code projects |
| `/api/export` | GET | Download all data as JSON (for static/cloud mode) |

## License

MIT
