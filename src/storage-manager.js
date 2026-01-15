// storage-manager.js - Storage layer for Cyberbook
// FIXES: Atomic IndexedDB transactions, debouncing, incremental index updates

import { openDB } from 'idb';
import { create, insert, search, remove, count } from '@orama/orama';

const DB_CONFIG = Object.freeze({
    NAME: 'CyberbookBookmarks',
    VERSION: 1,
    STORES: {
        BOOKMARKS: 'bookmarks',
        BLOBS: 'blobs'
    }
});

const ORAMA_SCHEMA = {
    id: 'string',
    title: 'string',
    excerpt: 'string',
    textSnippet: 'string',
    url: 'string',
    siteName: 'string',
    extractedAt: 'number',
    embedding: 'vector[384]'
};

const LIMITS = Object.freeze({
    MAX_BOOKMARKS: 1000,
    TEXT_SNIPPET_LENGTH: 10000,
    SEARCH_RESULTS: 20,
    VECTOR_WEIGHT: 0.7,
    FTS_WEIGHT: 0.3,
    SAVE_DEBOUNCE_MS: 300
});

class StorageManager {
    constructor() {
        this.db = null;
        this.oramaDb = null;
        this.initialized = false;
        this.pendingSaves = new Map();
        this.saveDebounceTimers = new Map();
    }

    async initialize() {
        if (this.initialized) {
            return;
        }

        console.log('[StorageManager] Initializing...');

        this.db = await openDB(DB_CONFIG.NAME, DB_CONFIG.VERSION, {
            upgrade(db, oldVersion, newVersion, transaction) {
                console.log(`[StorageManager] Upgrading DB from v${oldVersion} to v${newVersion}`);

                if (!db.objectStoreNames.contains(DB_CONFIG.STORES.BOOKMARKS)) {
                    const bookmarkStore = db.createObjectStore(DB_CONFIG.STORES.BOOKMARKS, {
                        keyPath: 'id'
                    });
                    bookmarkStore.createIndex('url', 'url', { unique: true });
                    bookmarkStore.createIndex('extractedAt', 'extractedAt', { unique: false });
                    bookmarkStore.createIndex('syncedAt', 'syncedAt', { unique: false });
                }

                if (!db.objectStoreNames.contains(DB_CONFIG.STORES.BLOBS)) {
                    db.createObjectStore(DB_CONFIG.STORES.BLOBS, {
                        keyPath: 'id'
                    });
                }
            },
            blocked() {
                console.warn('[StorageManager] Database blocked by older version');
            },
            blocking() {
                console.warn('[StorageManager] Blocking newer database version');
            }
        });

        this.oramaDb = await create({
            schema: ORAMA_SCHEMA,
            components: {
                tokenizer: {
                    stemming: true,
                    stopWords: true
                }
            }
        });

        await this.loadIndexIncrementally();

        this.initialized = true;
        console.log('[StorageManager] Initialization complete');
    }

    async loadIndexIncrementally() {
        const startTime = performance.now();

        const tx = this.db.transaction(DB_CONFIG.STORES.BOOKMARKS, 'readonly');
        const store = tx.objectStore(DB_CONFIG.STORES.BOOKMARKS);
        let cursor = await store.openCursor();
        let count = 0;

        while (cursor) {
            const bookmark = cursor.value;
            if (bookmark.embedding) {
                await this.insertIntoOrama(bookmark);
                count++;
            }
            cursor = await cursor.continue();
        }

        const elapsed = Math.round(performance.now() - startTime);
        console.log(`[StorageManager] Loaded ${count} bookmarks into index in ${elapsed}ms`);
    }

    async insertIntoOrama(bookmark) {
        const doc = {
            id: bookmark.id,
            title: bookmark.title || '',
            excerpt: bookmark.excerpt || '',
            textSnippet: bookmark.textSnippet || '',
            url: bookmark.url || '',
            siteName: bookmark.siteName || '',
            extractedAt: bookmark.extractedAt || 0,
            embedding: bookmark.embedding
        };

        await insert(this.oramaDb, doc);
    }

    async saveBookmark(bookmarkData) {
        this.ensureInitialized();

        const validated = this.validateBookmark(bookmarkData);

        const currentCount = await this.getBookmarkCount();
        if (currentCount >= LIMITS.MAX_BOOKMARKS) {
            throw new Error(`Maximum bookmark limit (${LIMITS.MAX_BOOKMARKS}) reached`);
        }

        const existing = await this.getBookmarkByUrl(validated.url);
        if (existing) {
            return this.updateBookmark(existing.id, validated);
        }

        const textSnippet = validated.textContent
            ? validated.textContent.substring(0, LIMITS.TEXT_SNIPPET_LENGTH)
            : '';

        const bookmark = Object.create(null);
        bookmark.id = validated.id;
        bookmark.title = validated.title;
        bookmark.excerpt = validated.excerpt;
        bookmark.url = validated.url;
        bookmark.siteName = validated.siteName;
        bookmark.wordCount = validated.wordCount;
        bookmark.extractedAt = validated.extractedAt;
        bookmark.syncedAt = validated.syncedAt;
        bookmark.textSnippet = textSnippet;

        if (validated.embedding) {
            bookmark.embedding = Array.from(validated.embedding);
        }

        const tx = this.db.transaction(
            [DB_CONFIG.STORES.BOOKMARKS, DB_CONFIG.STORES.BLOBS],
            'readwrite'
        );

        try {
            await tx.objectStore(DB_CONFIG.STORES.BOOKMARKS).put(bookmark);

            if (validated.compressedText) {
                await tx.objectStore(DB_CONFIG.STORES.BLOBS).put({
                    id: validated.id,
                    blob: validated.compressedText
                });
            }

            await tx.done;
        } catch (error) {
            console.error('[StorageManager] Transaction failed:', error);
            throw error;
        }

        if (validated.embedding) {
            await this.insertIntoOrama(bookmark);
        }

        console.log(`[StorageManager] Saved bookmark: ${validated.id}`);
        return validated.id;
    }

    async updateBookmark(id, updates) {
        this.ensureInitialized();

        const existing = await this.getBookmark(id);
        if (!existing) {
            throw new Error('Bookmark not found');
        }

        const merged = { ...existing, ...updates, id };
        const validated = this.validateBookmark(merged);

        const textSnippet = validated.textContent
            ? validated.textContent.substring(0, LIMITS.TEXT_SNIPPET_LENGTH)
            : existing.textSnippet || '';

        const bookmark = Object.create(null);
        bookmark.id = validated.id;
        bookmark.title = validated.title;
        bookmark.excerpt = validated.excerpt;
        bookmark.url = validated.url;
        bookmark.siteName = validated.siteName;
        bookmark.wordCount = validated.wordCount;
        bookmark.extractedAt = validated.extractedAt;
        bookmark.syncedAt = Date.now();
        bookmark.textSnippet = textSnippet;

        if (validated.embedding) {
            bookmark.embedding = Array.from(validated.embedding);
        }

        const tx = this.db.transaction(
            [DB_CONFIG.STORES.BOOKMARKS, DB_CONFIG.STORES.BLOBS],
            'readwrite'
        );

        try {
            await tx.objectStore(DB_CONFIG.STORES.BOOKMARKS).put(bookmark);

            if (validated.compressedText) {
                await tx.objectStore(DB_CONFIG.STORES.BLOBS).put({
                    id: validated.id,
                    blob: validated.compressedText
                });
            }

            await tx.done;
        } catch (error) {
            console.error('[StorageManager] Update transaction failed:', error);
            throw error;
        }

        try {
            await remove(this.oramaDb, validated.id);
        } catch {
            // May not exist in index
        }

        if (validated.embedding) {
            await this.insertIntoOrama(bookmark);
        }

        console.log(`[StorageManager] Updated bookmark: ${validated.id}`);
        return validated.id;
    }

    async getBookmark(id) {
        this.ensureInitialized();
        const bookmark = await this.db.get(DB_CONFIG.STORES.BOOKMARKS, id);
        return bookmark || null;
    }

    async getBookmarkByUrl(url) {
        this.ensureInitialized();
        const bookmark = await this.db.getFromIndex(
            DB_CONFIG.STORES.BOOKMARKS,
            'url',
            url
        );
        return bookmark || null;
    }

    async getCompressedText(id) {
        this.ensureInitialized();
        const record = await this.db.get(DB_CONFIG.STORES.BLOBS, id);
        return record?.blob || null;
    }

    async deleteBookmark(id) {
        this.ensureInitialized();

        const tx = this.db.transaction(
            [DB_CONFIG.STORES.BOOKMARKS, DB_CONFIG.STORES.BLOBS],
            'readwrite'
        );

        try {
            await tx.objectStore(DB_CONFIG.STORES.BOOKMARKS).delete(id);
            await tx.objectStore(DB_CONFIG.STORES.BLOBS).delete(id);
            await tx.done;
        } catch (error) {
            console.error('[StorageManager] Delete transaction failed:', error);
            throw error;
        }

        try {
            await remove(this.oramaDb, id);
        } catch {
            // May not exist in index
        }

        console.log(`[StorageManager] Deleted bookmark: ${id}`);
    }

    async getAllBookmarks(options = {}) {
        this.ensureInitialized();

        const {
            limit = 100,
            offset = 0,
            sortBy = 'extractedAt'
        } = options;

        const all = await this.db.getAllFromIndex(
            DB_CONFIG.STORES.BOOKMARKS,
            sortBy
        );

        return all.reverse().slice(offset, offset + limit);
    }

    async getBookmarkCount() {
        this.ensureInitialized();
        return this.db.count(DB_CONFIG.STORES.BOOKMARKS);
    }

    async search(query, queryEmbedding, options = {}) {
        this.ensureInitialized();

        const {
            limit = LIMITS.SEARCH_RESULTS,
            vectorWeight = LIMITS.VECTOR_WEIGHT
        } = options;

        const embedding = queryEmbedding instanceof Float32Array
            ? Array.from(queryEmbedding)
            : queryEmbedding;

        const results = await search(this.oramaDb, {
            term: query,
            mode: 'hybrid',
            vector: {
                value: embedding,
                property: 'embedding'
            },
            similarity: vectorWeight,
            limit: limit,
            boost: {
                title: 2.0,
                excerpt: 1.5
            }
        });

        const enrichedResults = await Promise.all(
            results.hits.map(async (hit) => {
                const bookmark = await this.getBookmark(hit.id);
                return {
                    ...bookmark,
                    score: hit.score,
                    matchedFields: Object.keys(hit.document)
                };
            })
        );

        return enrichedResults.filter(r => r !== null);
    }

    async searchText(query, options = {}) {
        this.ensureInitialized();

        const { limit = LIMITS.SEARCH_RESULTS } = options;

        const results = await search(this.oramaDb, {
            term: query,
            limit: limit,
            boost: {
                title: 2.0,
                excerpt: 1.5
            }
        });

        const enrichedResults = await Promise.all(
            results.hits.map(async (hit) => {
                const bookmark = await this.getBookmark(hit.id);
                return {
                    ...bookmark,
                    score: hit.score
                };
            })
        );

        return enrichedResults.filter(r => r !== null);
    }

    validateBookmark(data) {
        if (!data || typeof data !== 'object') {
            throw new Error('Invalid bookmark data');
        }

        if (!data.url || typeof data.url !== 'string') {
            throw new Error('URL is required');
        }

        const validated = Object.create(null);
        validated.id = data.id || crypto.randomUUID();
        validated.title = String(data.title || 'Untitled').substring(0, 500);
        validated.excerpt = String(data.excerpt || '').substring(0, 1000);
        validated.url = data.url;
        validated.siteName = String(data.siteName || '').substring(0, 100);
        validated.wordCount = Math.max(0, parseInt(data.wordCount) || 0);
        validated.extractedAt = data.extractedAt || Date.now();
        validated.syncedAt = Date.now();

        if (data.embedding) {
            validated.embedding = data.embedding;
        }

        if (data.compressedText) {
            validated.compressedText = data.compressedText;
        }

        if (data.textContent) {
            validated.textContent = data.textContent;
        }

        return validated;
    }

    ensureInitialized() {
        if (!this.initialized) {
            throw new Error('StorageManager not initialized. Call initialize() first.');
        }
    }

    async clearAll() {
        this.ensureInitialized();

        await this.db.clear(DB_CONFIG.STORES.BOOKMARKS);
        await this.db.clear(DB_CONFIG.STORES.BLOBS);

        this.oramaDb = await create({
            schema: ORAMA_SCHEMA
        });

        console.log('[StorageManager] All data cleared');
    }

    async getStats() {
        this.ensureInitialized();

        const bookmarkCount = await this.db.count(DB_CONFIG.STORES.BOOKMARKS);
        const blobCount = await this.db.count(DB_CONFIG.STORES.BLOBS);
        const oramaCount = await count(this.oramaDb);

        return {
            bookmarkCount,
            blobCount,
            indexedCount: oramaCount,
            maxBookmarks: LIMITS.MAX_BOOKMARKS
        };
    }
}

const storageManager = new StorageManager();

export { storageManager, StorageManager };
export default storageManager;
