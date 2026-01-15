// storage-manager.js - Storage layer for Cyberbook
// FIXES APPLIED:
// - Atomic IndexedDB transactions for bookmark + blob
// - Incremental Orama index (not full rebuild on startup)
// - Proper error handling

import { openDB } from 'idb';
import { create, insert, search, remove, count } from '@orama/orama';

const DB_CONFIG = Object.freeze({
    NAME: 'CyberbookData',
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
    FTS_WEIGHT: 0.3
});

class StorageManager {
    constructor() {
        this.db = null;
        this.oramaDb = null;
        this.initialized = false;
        this.indexedIds = new Set(); // Track what's in Orama
    }

    async initialize() {
        if (this.initialized) {
            return;
        }

        console.log('[StorageManager] Initializing...');

        this.db = await openDB(DB_CONFIG.NAME, DB_CONFIG.VERSION, {
            upgrade(db, oldVersion, newVersion) {
                console.log(`[StorageManager] Upgrading DB from v${oldVersion} to v${newVersion}`);

                if (!db.objectStoreNames.contains(DB_CONFIG.STORES.BOOKMARKS)) {
                    const store = db.createObjectStore(DB_CONFIG.STORES.BOOKMARKS, { keyPath: 'id' });
                    store.createIndex('url', 'url', { unique: true });
                    store.createIndex('extractedAt', 'extractedAt', { unique: false });
                }

                if (!db.objectStoreNames.contains(DB_CONFIG.STORES.BLOBS)) {
                    db.createObjectStore(DB_CONFIG.STORES.BLOBS, { keyPath: 'id' });
                }
            }
        });

        // Create Orama index
        this.oramaDb = await create({ schema: ORAMA_SCHEMA });

        // Incrementally load existing bookmarks into Orama
        await this.loadIndexFromDb();

        this.initialized = true;
        console.log('[StorageManager] Initialization complete');
    }

    /**
     * Load bookmarks into Orama incrementally
     * Only loads bookmarks with embeddings
     */
    async loadIndexFromDb() {
        const startTime = performance.now();
        const tx = this.db.transaction(DB_CONFIG.STORES.BOOKMARKS, 'readonly');
        const store = tx.objectStore(DB_CONFIG.STORES.BOOKMARKS);
        
        let cursor = await store.openCursor();
        let count = 0;

        while (cursor) {
            const bookmark = cursor.value;
            if (bookmark.embedding && !this.indexedIds.has(bookmark.id)) {
                await this.insertIntoOrama(bookmark);
                this.indexedIds.add(bookmark.id);
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
            embedding: Array.isArray(bookmark.embedding) 
                ? bookmark.embedding 
                : Array.from(bookmark.embedding)
        };

        await insert(this.oramaDb, doc);
    }

    /**
     * Save bookmark with atomic transaction for bookmark + blob
     */
    async saveBookmark(bookmarkData) {
        this.ensureInitialized();

        const validated = this.validateBookmark(bookmarkData);

        // Check limit
        const currentCount = await this.getBookmarkCount();
        if (currentCount >= LIMITS.MAX_BOOKMARKS) {
            throw new Error(`Maximum bookmark limit (${LIMITS.MAX_BOOKMARKS}) reached`);
        }

        // Check for duplicate
        const existing = await this.getBookmarkByUrl(validated.url);
        if (existing) {
            return this.updateBookmark(existing.id, validated);
        }

        const textSnippet = validated.textContent
            ? validated.textContent.substring(0, LIMITS.TEXT_SNIPPET_LENGTH)
            : '';

        const bookmark = {
            id: validated.id,
            title: validated.title,
            excerpt: validated.excerpt,
            url: validated.url,
            siteName: validated.siteName,
            wordCount: validated.wordCount,
            extractedAt: validated.extractedAt,
            textSnippet
        };

        if (validated.embedding) {
            bookmark.embedding = Array.from(validated.embedding);
        }

        // ATOMIC: Use single transaction for both stores
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
            console.error('[StorageManager] Atomic save failed:', error);
            throw error;
        }

        // Add to Orama after successful DB write
        if (validated.embedding) {
            await this.insertIntoOrama(bookmark);
            this.indexedIds.add(bookmark.id);
        }

        console.log(`[StorageManager] Saved bookmark: ${validated.id}`);
        return validated.id;
    }

    async updateBookmark(id, updates) {
        this.ensureInitialized();

        const existing = await this.db.get(DB_CONFIG.STORES.BOOKMARKS, id);
        if (!existing) {
            throw new Error('Bookmark not found');
        }

        const updated = { ...existing, ...updates, id };
        if (updates.embedding) {
            updated.embedding = Array.from(updates.embedding);
        }

        const tx = this.db.transaction(
            [DB_CONFIG.STORES.BOOKMARKS, DB_CONFIG.STORES.BLOBS],
            'readwrite'
        );

        try {
            await tx.objectStore(DB_CONFIG.STORES.BOOKMARKS).put(updated);

            if (updates.compressedText) {
                await tx.objectStore(DB_CONFIG.STORES.BLOBS).put({
                    id,
                    blob: updates.compressedText
                });
            }

            await tx.done;
        } catch (error) {
            console.error('[StorageManager] Atomic update failed:', error);
            throw error;
        }

        // Update Orama
        if (this.indexedIds.has(id)) {
            try {
                await remove(this.oramaDb, id);
            } catch (_) {}
        }

        if (updated.embedding) {
            await this.insertIntoOrama(updated);
            this.indexedIds.add(id);
        }

        return id;
    }

    async deleteBookmark(id) {
        this.ensureInitialized();

        // ATOMIC: Delete both in single transaction
        const tx = this.db.transaction(
            [DB_CONFIG.STORES.BOOKMARKS, DB_CONFIG.STORES.BLOBS],
            'readwrite'
        );

        try {
            await tx.objectStore(DB_CONFIG.STORES.BOOKMARKS).delete(id);
            await tx.objectStore(DB_CONFIG.STORES.BLOBS).delete(id);
            await tx.done;
        } catch (error) {
            console.error('[StorageManager] Atomic delete failed:', error);
            throw error;
        }

        // Remove from Orama
        if (this.indexedIds.has(id)) {
            try {
                await remove(this.oramaDb, id);
                this.indexedIds.delete(id);
            } catch (_) {}
        }

        console.log(`[StorageManager] Deleted bookmark: ${id}`);
    }

    async getBookmark(id) {
        this.ensureInitialized();
        return this.db.get(DB_CONFIG.STORES.BOOKMARKS, id);
    }

    async getBookmarkByUrl(url) {
        this.ensureInitialized();
        const index = this.db.transaction(DB_CONFIG.STORES.BOOKMARKS).store.index('url');
        return index.get(url);
    }

    async getAllBookmarks({ limit = 100, offset = 0 } = {}) {
        this.ensureInitialized();
        const all = await this.db.getAll(DB_CONFIG.STORES.BOOKMARKS);
        all.sort((a, b) => (b.extractedAt || 0) - (a.extractedAt || 0));
        return all.slice(offset, offset + limit);
    }

    async getBookmarkCount() {
        this.ensureInitialized();
        return this.db.count(DB_CONFIG.STORES.BOOKMARKS);
    }

    /**
     * Hybrid search: vector + full-text
     */
    async search(query, queryEmbedding, { limit = LIMITS.SEARCH_RESULTS } = {}) {
        this.ensureInitialized();

        const results = await search(this.oramaDb, {
            term: query,
            vector: {
                value: Array.from(queryEmbedding),
                property: 'embedding'
            },
            similarity: LIMITS.VECTOR_WEIGHT,
            limit,
            boost: {
                title: 2,
                excerpt: 1.5
            }
        });

        return results.hits.map(hit => ({
            ...hit.document,
            score: hit.score
        }));
    }

    /**
     * Text-only search fallback
     */
    async searchText(query, { limit = LIMITS.SEARCH_RESULTS } = {}) {
        this.ensureInitialized();

        const results = await search(this.oramaDb, {
            term: query,
            limit,
            boost: {
                title: 2,
                excerpt: 1.5
            }
        });

        return results.hits.map(hit => ({
            ...hit.document,
            score: hit.score
        }));
    }

    async getStats() {
        this.ensureInitialized();

        const bookmarkCount = await this.db.count(DB_CONFIG.STORES.BOOKMARKS);
        const blobCount = await this.db.count(DB_CONFIG.STORES.BLOBS);
        const indexedCount = await count(this.oramaDb);

        return {
            bookmarkCount,
            blobCount,
            indexedCount,
            maxBookmarks: LIMITS.MAX_BOOKMARKS
        };
    }

    validateBookmark(data) {
        if (!data || typeof data !== 'object') {
            throw new Error('Invalid bookmark data');
        }

        if (!data.url || typeof data.url !== 'string') {
            throw new Error('URL is required');
        }

        return {
            id: data.id || crypto.randomUUID(),
            title: String(data.title || 'Untitled').substring(0, 500),
            excerpt: String(data.excerpt || '').substring(0, 1000),
            url: data.url,
            siteName: String(data.siteName || '').substring(0, 100),
            wordCount: Math.max(0, parseInt(data.wordCount) || 0),
            extractedAt: data.extractedAt || Date.now(),
            embedding: data.embedding || null,
            compressedText: data.compressedText || null,
            textContent: data.textContent || null
        };
    }

    ensureInitialized() {
        if (!this.initialized) {
            throw new Error('StorageManager not initialized');
        }
    }

    async clearAll() {
        this.ensureInitialized();
        await this.db.clear(DB_CONFIG.STORES.BOOKMARKS);
        await this.db.clear(DB_CONFIG.STORES.BLOBS);
        this.oramaDb = await create({ schema: ORAMA_SCHEMA });
        this.indexedIds.clear();
        console.log('[StorageManager] All data cleared');
    }
}

const storageManager = new StorageManager();
export { storageManager, StorageManager };
export default storageManager;
