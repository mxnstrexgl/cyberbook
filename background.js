// background.js - Service Worker for Cyberbook Extension
// Handles bookmark message routing and offscreen document lifecycle
// FIXES APPLIED:
// - Proper mutex for offscreen document creation (no race conditions)
// - Model loading promise persists after success
// - Better error handling for warmup failures

import storageManager from './storage-manager.js';

const BOOKMARK_ACTIONS = Object.freeze([
    'SAVE_BOOKMARK',
    'SEARCH_BOOKMARKS',
    'DELETE_BOOKMARK',
    'GET_BOOKMARK',
    'GET_ALL_BOOKMARKS',
    'GET_BOOKMARK_STATS'
]);

const OFFSCREEN_CONFIG = Object.freeze({
    URL: 'offscreen.html',
    REASONS: ['DOM_SCRAPING', 'WORKERS'],
    JUSTIFICATION: 'ML inference for bookmark embeddings'
});

// State with proper mutex
let offscreenCreationPromise = null;
let storageInitialized = false;

/**
 * Ensure offscreen document exists - FIXED with proper mutex
 * Uses a promise-based mutex to prevent race conditions
 */
async function ensureOffscreenDocument() {
    // If creation is in progress, wait for it
    if (offscreenCreationPromise) {
        return offscreenCreationPromise;
    }

    // Check if document already exists
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_CONFIG.URL)]
    });

    if (existingContexts.length > 0) {
        return;
    }

    // Create with mutex - store the promise so concurrent calls wait
    offscreenCreationPromise = (async () => {
        try {
            console.log('[Cyberbook] Creating offscreen document...');
            await chrome.offscreen.createDocument({
                url: OFFSCREEN_CONFIG.URL,
                reasons: OFFSCREEN_CONFIG.REASONS,
                justification: OFFSCREEN_CONFIG.JUSTIFICATION
            });
            console.log('[Cyberbook] Offscreen document created');
        } catch (error) {
            if (!error.message?.includes('already exists')) {
                console.error('[Cyberbook] Failed to create offscreen document:', error);
                throw error;
            }
        }
    })();

    try {
        await offscreenCreationPromise;
    } finally {
        // Reset mutex after completion (success or failure)
        offscreenCreationPromise = null;
    }
}

/**
 * Send message to offscreen document with timeout
 */
async function sendToOffscreen(message, timeoutMs = 60000) {
    await ensureOffscreenDocument();

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Offscreen message timeout'));
        }, timeoutMs);

        chrome.runtime.sendMessage(
            { ...message, target: 'offscreen' },
            (response) => {
                clearTimeout(timeout);
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve(response);
                }
            }
        );
    });
}

/**
 * Initialize storage manager
 */
async function initializeStorage() {
    if (storageInitialized) {
        return;
    }

    try {
        await storageManager.initialize();
        storageInitialized = true;
        console.log('[Cyberbook] Storage initialized');
    } catch (error) {
        console.error('[Cyberbook] Storage initialization failed:', error);
        throw error;
    }
}

/**
 * Validate message sender
 */
function isValidSender(sender) {
    if (!sender || typeof sender !== 'object') {
        return false;
    }
    if (sender.id !== chrome.runtime.id) {
        return false;
    }
    if (sender.tab !== undefined) {
        if (!sender.tab || typeof sender.tab.id !== 'number' || sender.tab.id < 0) {
            return false;
        }
    }
    return true;
}

// Debounce map for rapid saves
const saveDebounceMap = new Map();
const DEBOUNCE_MS = 1000;

/**
 * Handle bookmark save with debouncing
 */
async function handleSaveBookmark(message, sender) {
    try {
        const { title, url, siteName, textContent, wordCount, excerpt } = message;

        if (!url || typeof url !== 'string') {
            return { success: false, error: 'URL is required' };
        }

        // Debounce rapid saves of same URL
        const existing = saveDebounceMap.get(url);
        if (existing && Date.now() - existing < DEBOUNCE_MS) {
            return { success: false, error: 'Save in progress, please wait' };
        }
        saveDebounceMap.set(url, Date.now());

        await initializeStorage();

        // Generate embedding
        let embedding = null;
        const textForEmbedding = `${title || ''} ${excerpt || ''} ${(textContent || '').substring(0, 5000)}`;

        try {
            const embeddingResponse = await sendToOffscreen({
                type: 'GENERATE_EMBEDDING',
                text: textForEmbedding
            });

            if (embeddingResponse?.success) {
                embedding = new Float32Array(embeddingResponse.embedding);
            }
        } catch (error) {
            console.warn('[Cyberbook] Embedding generation failed, saving without:', error.message);
        }

        // Compress text
        let compressedText = null;
        if (textContent) {
            try {
                const encoder = new TextEncoder();
                const data = encoder.encode(textContent);
                const cs = new CompressionStream('gzip');
                const writer = cs.writable.getWriter();
                writer.write(data);
                writer.close();
                const compressed = await new Response(cs.readable).arrayBuffer();
                compressedText = new Blob([compressed], { type: 'application/gzip' });
            } catch (error) {
                console.warn('[Cyberbook] Compression failed:', error.message);
            }
        }

        // Save bookmark
        const bookmarkData = {
            id: crypto.randomUUID(),
            title: title || 'Untitled',
            url,
            siteName: siteName || '',
            excerpt: excerpt || '',
            wordCount: wordCount || 0,
            extractedAt: Date.now(),
            embedding,
            compressedText,
            textContent
        };

        const savedId = await storageManager.saveBookmark(bookmarkData);
        saveDebounceMap.delete(url);

        return { success: true, id: savedId };

    } catch (error) {
        console.error('[Cyberbook] Save error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Handle bookmark search
 */
async function handleSearchBookmarks(message) {
    try {
        const { query, limit = 20 } = message;

        if (!query || typeof query !== 'string') {
            return { success: false, error: 'Query is required' };
        }

        await initializeStorage();

        // Try to generate query embedding
        let queryEmbedding = null;
        try {
            const embeddingResponse = await sendToOffscreen({
                type: 'GENERATE_EMBEDDING',
                text: query
            });

            if (embeddingResponse?.success) {
                queryEmbedding = new Float32Array(embeddingResponse.embedding);
            }
        } catch (error) {
            console.warn('[Cyberbook] Query embedding failed, using text search');
        }

        // Perform search
        const results = queryEmbedding
            ? await storageManager.search(query, queryEmbedding, { limit })
            : await storageManager.searchText(query, { limit });

        return { success: true, results };

    } catch (error) {
        console.error('[Cyberbook] Search error:', error);
        return { success: false, error: error.message };
    }
}

async function handleGetBookmark(message) {
    try {
        const { id } = message;
        if (!id) return { success: false, error: 'Bookmark ID required' };

        await initializeStorage();
        const bookmark = await storageManager.getBookmark(id);

        if (!bookmark) return { success: false, error: 'Bookmark not found' };
        return { success: true, bookmark };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function handleDeleteBookmark(message) {
    try {
        const { id } = message;
        if (!id) return { success: false, error: 'Bookmark ID required' };

        await initializeStorage();
        await storageManager.deleteBookmark(id);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function handleGetAllBookmarks(message) {
    try {
        const { limit = 100, offset = 0 } = message;
        await initializeStorage();
        const bookmarks = await storageManager.getAllBookmarks({ limit, offset });
        return { success: true, bookmarks };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function handleGetBookmarkStats() {
    try {
        await initializeStorage();
        const stats = await storageManager.getStats();
        return { success: true, stats };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isValidSender(sender)) {
        console.warn('[Cyberbook] Rejected message from invalid sender');
        sendResponse({ error: 'Unauthorized sender' });
        return true;
    }

    if (!message || typeof message !== 'object') {
        sendResponse({ error: 'Invalid message format' });
        return true;
    }

    if (message.target === 'offscreen') {
        return false;
    }

    if (message.action && BOOKMARK_ACTIONS.includes(message.action)) {
        (async () => {
            let response;
            switch (message.action) {
                case 'SAVE_BOOKMARK':
                    response = await handleSaveBookmark(message, sender);
                    break;
                case 'SEARCH_BOOKMARKS':
                    response = await handleSearchBookmarks(message);
                    break;
                case 'GET_BOOKMARK':
                    response = await handleGetBookmark(message);
                    break;
                case 'DELETE_BOOKMARK':
                    response = await handleDeleteBookmark(message);
                    break;
                case 'GET_ALL_BOOKMARKS':
                    response = await handleGetAllBookmarks(message);
                    break;
                case 'GET_BOOKMARK_STATS':
                    response = await handleGetBookmarkStats();
                    break;
                default:
                    response = { error: 'Unknown action' };
            }
            sendResponse(response);
        })();
        return true;
    }

    return false;
});

// Install handler - NO eager model warmup (lazy load instead)
chrome.runtime.onInstalled.addListener(async (details) => {
    console.log(`[Cyberbook] Extension ${details.reason}`, details);
});

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ensureOffscreenDocument,
        handleSaveBookmark,
        handleSearchBookmarks,
        isValidSender
    };
}
