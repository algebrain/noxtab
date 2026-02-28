# NoxTab

NoxTab is a compact Node.js CLI for Chrome DevTools Protocol (CDP) automation and debugging.

Detailed documentation: [docs/NOXTAB.md](./docs/NOXTAB.md).

```bash
chrome --remote-debugging-port=9222
```

## Install

```bash
cd tool
npm install
```

## Usage

```bash
node cdp-tool.js list
node cdp-tool.js open http://127.0.0.1:8080
node cdp-tool.js eval "document.title"
node cdp-tool.js click "#addBtn"
node cdp-tool.js type "#todoInput" "buy milk"
node cdp-tool.js screenshot ../demo/screenshots/state.png
node cdp-tool.js logs
```

### Optional flags
- `--host=127.0.0.1` (default)
- `--port=9222` (default)
- `--target=<id>` to pick an exact target id
- `--url-contains=<part>` to pick a tab by URL substring
- `--title-contains=<part>` to pick a tab by title substring

## Commands
- `list` list inspectable page targets
- `open <url>` navigate in the selected tab
- `eval <js>` evaluate JavaScript and print the result
- `click <selector>` click an element matched by selector
- `type <selector> <text>` focus element, set value, dispatch input/change
- `screenshot <path>` save a PNG screenshot without overwrite; if the file exists, save as `name-001.png`, `name-002.png`, ...
- `logs` stream console and page errors until `Ctrl+C`
