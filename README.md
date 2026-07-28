# Cyberbook

**AI-powered semantic bookmark search extension.**

Save any page and find it later by *meaning*, not just keywords.

## Features

- 🧠 **Semantic Search** - Find bookmarks by what they're *about*, not exact text
- 📖 **Article Extraction** - Automatically extracts readable content via Readability
- ⚡ **Hybrid Search** - Combines AI vector search with full-text for best results
- 💾 **Local Storage** - All data stays in your browser (IndexedDB)
- 🔒 **Privacy First** - No cloud sync, no data leaves your device
- 📊 **ML Embeddings** - Uses MiniLM-L6-v2 for semantic understanding

## How It Works

1. Click "Save This Page" on any article or webpage
2. Cyberbook extracts the content and generates semantic embeddings
3. Search your bookmarks using natural language queries
4. Results ranked by meaning similarity, not just keyword matching

## Installation

### Development

```bash
npm install
npm run build
```

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `dist` folder

### From Source

```bash
git clone https://github.com/your-repo/cyberbook.git
cd cyberbook
npm install
npm run build
```

## Architecture

- **content.js** - Extracts page content using Mozilla Readability
- **background.js** - Routes messages, manages offscreen document
- **offscreen.js** - Runs ML inference in isolated context (required for WASM)
- **storage-manager.js** - IndexedDB + Orama hybrid search layer

## Technical Notes

- Uses `@huggingface/transformers` for in-browser ML inference
- Model: `Xenova/all-MiniLM-L6-v2` (~23MB, downloaded on first use)
- Embeddings are 384-dimensional vectors
- Search combines cosine similarity (70%) + BM25 full-text (30%)

## License

MIT License
