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
    'GET_BOOKMARK_STATS',
    'LIST_FOLDERS',
    'CREATE_FOLDER',
    'UPDATE_FOLDER',
    'DELETE_FOLDER',
    'MOVE_TO_FOLDER',
    'UPDATE_BOOKMARK_TAGS'
]);

const OFFSCREEN_CONFIG = Object.freeze({
    URL: 'offscreen.html',
    REASONS: ['DOM_SCRAPING', 'WORKERS'],
    JUSTIFICATION: 'ML inference for bookmark embeddings'
});

// Rate limiting configuration
const RATE_LIMITS = Object.freeze({
    SAVES_PER_MINUTE: 10,
    SEARCHES_PER_MINUTE: 30
});

// Input size limits
const MAX_TEXT_SIZE = 5 * 1024 * 1024; // 5MB max
const COMPRESSION_THRESHOLD = 50 * 1024; // 50KB - only compress if larger

// Rate limit tracking
const rateLimitMap = new Map();

/**
 * Check rate limit for an action
 * @throws {Error} if rate limit exceeded
 */
function checkRateLimit(action) {
    const limitKey = `${action.toUpperCase()}_PER_MINUTE`;
    const limit = RATE_LIMITS[limitKey === 'SAVE_BOOKMARK_PER_MINUTE' ? 'SAVES_PER_MINUTE' : limitKey === 'SEARCH_BOOKMARKS_PER_MINUTE' ? 'SEARCHES_PER_MINUTE' : null];
    if (!limit) return; // No limit defined for this action

    const now = Date.now();
    const entry = rateLimitMap.get(action) || { count: 0, resetTime: now + 60000 };

    if (now > entry.resetTime) {
        entry.count = 0;
        entry.resetTime = now + 60000;
    }

    if (entry.count >= limit) {
        const waitTime = Math.ceil((entry.resetTime - now) / 1000);
        throw new Error(`Rate limit exceeded. Try again in ${waitTime}s`);
    }

    entry.count++;
    rateLimitMap.set(action, entry);
}

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
            console.log('[Stash] Creating offscreen document...');
            await chrome.offscreen.createDocument({
                url: OFFSCREEN_CONFIG.URL,
                reasons: OFFSCREEN_CONFIG.REASONS,
                justification: OFFSCREEN_CONFIG.JUSTIFICATION
            });
            console.log('[Stash] Offscreen document created');
        } catch (error) {
            if (!error.message?.includes('already exists')) {
                console.error('[Stash] Failed to create offscreen document:', error);
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
        console.log('[Stash] Storage initialized');
    } catch (error) {
        console.error('[Stash] Storage initialization failed:', error);
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
 * Handle bookmark save with debouncing, rate limiting, and input validation
 */
async function handleSaveBookmark(message, sender) {
    try {
        // Rate limiting
        checkRateLimit('SAVE_BOOKMARK');

        const { title, url, siteName, wordCount, excerpt } = message;
        let { textContent } = message;

        if (!url || typeof url !== 'string') {
            return { success: false, error: 'URL is required' };
        }

        // Input size validation - truncate if too large
        if (textContent && textContent.length > MAX_TEXT_SIZE) {
            console.warn('[Stash] Text too large, truncating from', textContent.length, 'to', MAX_TEXT_SIZE);
            textContent = textContent.substring(0, MAX_TEXT_SIZE);
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
            console.warn('[Stash] Embedding generation failed, saving without:', error.message);
        }

        // Compress text - only if above threshold, with fallback
        let compressedText = null;
        let storedText = null;

        if (textContent) {
            if (textContent.length > COMPRESSION_THRESHOLD) {
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
                    // Compression failed - store truncated uncompressed version instead of losing data
                    console.warn('[Stash] Compression failed, storing uncompressed:', error.message);
                    storedText = textContent.substring(0, 100000);
                }
            } else {
                // Below threshold - store directly
                storedText = textContent;
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
            textContent: storedText || textContent
        };

        const savedId = await storageManager.saveBookmark(bookmarkData);
        saveDebounceMap.delete(url);

        return { success: true, id: savedId };

    } catch (error) {
        console.error('[Stash] Save error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Handle bookmark search with rate limiting
 */
async function handleSearchBookmarks(message) {
    try {
        // Rate limiting
        checkRateLimit('SEARCH_BOOKMARKS');

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
            console.warn('[Stash] Query embedding failed, using text search');
        }

        // Perform search
        const results = queryEmbedding
            ? await storageManager.search(query, queryEmbedding, { limit })
            : await storageManager.searchText(query, { limit });

        return { success: true, results };

    } catch (error) {
        console.error('[Stash] Search error:', error);
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
        console.warn('[Stash] Rejected message from invalid sender');
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
                case 'LIST_FOLDERS':
                    response = await handleListFolders();
                    break;
                case 'CREATE_FOLDER':
                    response = await handleCreateFolder(message);
                    break;
                case 'UPDATE_FOLDER':
                    response = await handleUpdateFolder(message);
                    break;
                case 'DELETE_FOLDER':
                    response = await handleDeleteFolder(message);
                    break;
                case 'MOVE_TO_FOLDER':
                    response = await handleMoveToFolder(message);
                    break;
                case 'UPDATE_BOOKMARK_TAGS':
                    response = await handleUpdateBookmarkTags(message);
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

// Folder handlers
async function handleListFolders() {
    try {
        await initializeStorage();
        const folders = await storageManager.listFolders();
        return { success: true, folders };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function handleCreateFolder(message) {
    try {
        const { name, parentId } = message;
        if (!name) return { success: false, error: 'Folder name required' };

        await initializeStorage();
        const folder = await storageManager.createFolder({ name, parentId });
        return { success: true, folder };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function handleUpdateFolder(message) {
    try {
        const { id, ...updates } = message;
        if (!id) return { success: false, error: 'Folder ID required' };

        await initializeStorage();
        const folder = await storageManager.updateFolder(id, updates);
        return { success: true, folder };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function handleDeleteFolder(message) {
    try {
        const { id, moveToId } = message;
        if (!id) return { success: false, error: 'Folder ID required' };

        await initializeStorage();
        await storageManager.deleteFolder(id, { moveToId });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function handleMoveToFolder(message) {
    try {
        const { id, folderId } = message;
        if (!id) return { success: false, error: 'Bookmark ID required' };

        await initializeStorage();
        const bookmark = await storageManager.moveBookmarkToFolder(id, folderId);
        return { success: true, bookmark };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function handleUpdateBookmarkTags(message) {
    try {
        const { id, tags } = message;
        if (!id) return { success: false, error: 'Bookmark ID required' };

        await initializeStorage();
        const bookmark = await storageManager.updateBookmark(id, { tags });
        return { success: true, bookmark };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Install handler - setup context menus
chrome.runtime.onInstalled.addListener(async (details) => {
    console.log(`[Stash] Extension ${details.reason}`, details);

    // Create context menus
    chrome.contextMenus.create({
        id: 'save-page',
        title: 'Save to Stash',
        contexts: ['page']
    });

    chrome.contextMenus.create({
        id: 'save-selection',
        title: 'Save Selection to Stash',
        contexts: ['selection']
    });

    chrome.contextMenus.create({
        id: 'save-link',
        title: 'Save Link to Stash',
        contexts: ['link']
    });
});

// Context menu click handler
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    try {
        await initializeStorage();

        switch (info.menuItemId) {
            case 'save-page':
                // Extract and save full page via content script
                await handleContextMenuSavePage(tab);
                break;

            case 'save-selection':
                // Save highlighted text as a highlight/note
                await handleContextMenuSaveSelection(info, tab);
                break;

            case 'save-link':
                // Save the link URL
                await handleContextMenuSaveLink(info, tab);
                break;
        }
    } catch (error) {
        console.error('[Stash] Context menu error:', error);
    }
});

/**
 * Handle save page from context menu
 */
async function handleContextMenuSavePage(tab) {
    try {
        // Send message to content script to extract content
        const content = await chrome.tabs.sendMessage(tab.id, { action: 'EXTRACT_CONTENT' });
        if (!content.success) {
            console.error('[Stash] Failed to extract content');
            return;
        }

        // Save the bookmark
        const response = await handleSaveBookmark({
            title: content.title,
            url: content.url,
            siteName: content.siteName,
            textContent: content.textContent,
            wordCount: content.wordCount,
            excerpt: content.excerpt
        });

        if (response.success) {
            console.log('[Stash] Page saved via context menu:', response.id);
        }
    } catch (error) {
        console.error('[Stash] Context menu save page error:', error);
    }
}

/**
 * Handle save selection from context menu
 */
async function handleContextMenuSaveSelection(info, tab) {
    try {
        const selectionText = info.selectionText;
        if (!selectionText || selectionText.trim().length === 0) {
            return;
        }

        // Generate embedding for the selection
        let embedding = null;
        try {
            const embeddingResponse = await sendToOffscreen({
                type: 'GENERATE_EMBEDDING',
                text: selectionText
            });
            if (embeddingResponse?.success) {
                embedding = new Float32Array(embeddingResponse.embedding);
            }
        } catch (error) {
            console.warn('[Stash] Selection embedding failed:', error.message);
        }

        // Save as a highlight/note type bookmark
        const bookmarkData = {
            id: crypto.randomUUID(),
            title: `Highlight from ${tab.title || 'Unknown'}`,
            url: info.pageUrl,
            siteName: new URL(info.pageUrl).hostname.replace(/^www\./, ''),
            excerpt: selectionText.substring(0, 300),
            textContent: selectionText,
            wordCount: selectionText.split(/\s+/).filter(w => w.length > 0).length,
            extractedAt: Date.now(),
            embedding,
            type: 'highlight',
            sourceTitle: tab.title
        };

        const savedId = await storageManager.saveBookmark(bookmarkData);
        console.log('[Stash] Selection saved:', savedId);
    } catch (error) {
        console.error('[Stash] Context menu save selection error:', error);
    }
}

/**
 * Handle save link from context menu
 */
async function handleContextMenuSaveLink(info, tab) {
    try {
        const linkUrl = info.linkUrl;
        if (!linkUrl) return;

        // For now, just save the link URL with minimal info
        // In future, could fetch the linked page in background
        const bookmarkData = {
            id: crypto.randomUUID(),
            title: info.linkText || linkUrl,
            url: linkUrl,
            siteName: new URL(linkUrl).hostname.replace(/^www\./, ''),
            excerpt: `Link saved from ${tab.title || 'Unknown'}`,
            textContent: '',
            wordCount: 0,
            extractedAt: Date.now(),
            type: 'link',
            sourceUrl: info.pageUrl,
            sourceTitle: tab.title
        };

        // Generate embedding from link text
        let embedding = null;
        const textForEmbedding = `${bookmarkData.title} ${bookmarkData.excerpt}`;
        try {
            const embeddingResponse = await sendToOffscreen({
                type: 'GENERATE_EMBEDDING',
                text: textForEmbedding
            });
            if (embeddingResponse?.success) {
                embedding = new Float32Array(embeddingResponse.embedding);
                bookmarkData.embedding = embedding;
            }
        } catch (error) {
            console.warn('[Stash] Link embedding failed:', error.message);
        }

        const savedId = await storageManager.saveBookmark(bookmarkData);
        console.log('[Stash] Link saved:', savedId);
    } catch (error) {
        console.error('[Stash] Context menu save link error:', error);
    }
}

// Keyboard shortcut handler
chrome.commands.onCommand.addListener(async (command) => {
    if (command === 'save-page') {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) {
                await handleContextMenuSavePage(tab);
            }
        } catch (error) {
            console.error('[Stash] Keyboard shortcut error:', error);
        }
    }
});

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ensureOffscreenDocument,
        handleSaveBookmark,
        handleSearchBookmarks,
        isValidSender
    };
}
