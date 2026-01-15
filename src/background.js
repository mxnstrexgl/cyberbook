// background.js - Service Worker for Cyberbook Extension
// Handles bookmark message routing and offscreen document lifecycle
// FIXES: Proper mutex for offscreen creation, error handling for warmup

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

let storageInitialized = false;
let offscreenCreationPromise = null;

async function ensureOffscreenDocument() {
    if (offscreenCreationPromise) {
        return offscreenCreationPromise;
    }

    offscreenCreationPromise = (async () => {
        try {
            const existingContexts = await chrome.runtime.getContexts({
                contextTypes: ['OFFSCREEN_DOCUMENT'],
                documentUrls: [chrome.runtime.getURL(OFFSCREEN_CONFIG.URL)]
            });

            if (existingContexts.length > 0) {
                return;
            }

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
        offscreenCreationPromise = null;
    }
}

async function sendToOffscreen(message) {
    await ensureOffscreenDocument();

    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
            { ...message, target: 'offscreen' },
            (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve(response);
                }
            }
        );
    });
}

async function warmupModel() {
    try {
        console.log('[Cyberbook] Warming up ML model...');
        const response = await sendToOffscreen({ type: 'WARMUP_MODEL' });

        if (response?.success) {
            console.log(`[Cyberbook] Model warmed up in ${response.loadTimeMs}ms`);
        } else {
            console.warn('[Cyberbook] Model warmup failed:', response?.error);
        }
    } catch (error) {
        console.error('[Cyberbook] Model warmup error:', error);
    }
}

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

async function handleSaveBookmark(message, sender) {
    try {
        const tabId = message.tabId || sender?.tab?.id;

        if (!tabId) {
            return { success: false, error: 'No tab ID provided' };
        }

        await initializeStorage();

        console.log(`[Cyberbook] Extracting content from tab ${tabId}...`);

        let extractedContent;
        try {
            extractedContent = await chrome.tabs.sendMessage(tabId, {
                action: 'EXTRACT_CONTENT'
            });
        } catch (error) {
            return {
                success: false,
                error: 'Content script not available. Try refreshing the page.'
            };
        }

        if (!extractedContent?.success || !extractedContent?.data) {
            return {
                success: false,
                error: extractedContent?.error || 'Content extraction failed'
            };
        }

        const content = extractedContent.data;

        if (!content.url) {
            return { success: false, error: 'Invalid page URL' };
        }

        console.log(`[Cyberbook] Extracted: "${content.title}" (${content.wordCount} words)`);

        console.log('[Cyberbook] Generating embedding...');

        const embeddingText = [
            content.title,
            content.excerpt,
            content.textContent?.substring(0, 5000) || ''
        ].join(' ').trim();

        const embeddingResponse = await sendToOffscreen({
            type: 'GENERATE_EMBEDDING',
            text: embeddingText
        });

        if (!embeddingResponse?.success) {
            return {
                success: false,
                error: 'Embedding generation failed: ' + (embeddingResponse?.error || 'Unknown error')
            };
        }

        console.log('[Cyberbook] Compressing text...');

        const compressionResponse = await sendToOffscreen({
            type: 'COMPRESS',
            text: content.textContent || ''
        });

        let compressedText = null;
        if (compressionResponse?.success && compressionResponse?.compressedBase64) {
            const binary = atob(compressionResponse.compressedBase64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            compressedText = new Blob([bytes], { type: 'application/gzip' });
        }

        console.log('[Cyberbook] Saving bookmark...');

        const bookmarkData = {
            title: content.title,
            excerpt: content.excerpt,
            url: content.url,
            siteName: content.siteName,
            wordCount: content.wordCount,
            extractedAt: content.extractedAt,
            textContent: content.textContent,
            embedding: new Float32Array(embeddingResponse.embedding),
            compressedText: compressedText
        };

        const bookmarkId = await storageManager.saveBookmark(bookmarkData);

        console.log(`[Cyberbook] Bookmark saved: ${bookmarkId}`);

        return {
            success: true,
            id: bookmarkId,
            title: content.title
        };

    } catch (error) {
        console.error('[Cyberbook] Save bookmark error:', error);
        return {
            success: false,
            error: error.message || 'Unknown error'
        };
    }
}

async function handleSearchBookmarks(message) {
    try {
        const { query, limit = 20 } = message;

        if (!query || typeof query !== 'string') {
            return { success: false, error: 'Query is required' };
        }

        await initializeStorage();

        const embeddingResponse = await sendToOffscreen({
            type: 'GENERATE_EMBEDDING',
            text: query
        });

        if (!embeddingResponse?.success) {
            console.warn('[Cyberbook] Query embedding failed, using text search');
            const results = await storageManager.searchText(query, { limit });
            return { success: true, results };
        }

        const queryEmbedding = new Float32Array(embeddingResponse.embedding);
        const results = await storageManager.search(query, queryEmbedding, { limit });

        return { success: true, results };

    } catch (error) {
        console.error('[Cyberbook] Search error:', error);
        return { success: false, error: error.message };
    }
}

async function handleGetBookmark(message) {
    try {
        const { id } = message;

        if (!id) {
            return { success: false, error: 'Bookmark ID required' };
        }

        await initializeStorage();
        const bookmark = await storageManager.getBookmark(id);

        if (!bookmark) {
            return { success: false, error: 'Bookmark not found' };
        }

        return { success: true, bookmark };

    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function handleDeleteBookmark(message) {
    try {
        const { id } = message;

        if (!id) {
            return { success: false, error: 'Bookmark ID required' };
        }

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

chrome.runtime.onInstalled.addListener(async (details) => {
    console.log(`[Cyberbook] Extension ${details.reason}`, details);

    if (details.reason === 'install' || details.reason === 'update') {
        setTimeout(async () => {
            try {
                await warmupModel();
            } catch (error) {
                console.error('[Cyberbook] Warmup failed:', error);
            }
        }, 1000);
    }
});
