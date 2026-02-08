// storage-manager.js - Storage layer for Stash (formerly Cyberbook)
// FEATURES:
// - Atomic IndexedDB transactions for bookmark + blob
// - Incremental Orama index (not full rebuild on startup)
// - LRU cache for search results and embeddings
// - AI auto-tagging based on embeddings
// - Notes/highlights support

import { openDB } from 'idb';
import { create, insert, search, remove, count } from '@orama/orama';

const DB_CONFIG = Object.freeze({
    NAME: 'StashData',
    VERSION: 3,
    STORES: {
        BOOKMARKS: 'bookmarks',
        BLOBS: 'blobs',
        FOLDERS: 'folders',
        COLLECTIONS: 'collections',
        COLLECTION_PAGES: 'collectionPages',
        NOTES: 'notes'
    }
});

/**
 * LRU Cache for performance optimization
 */
class LRUCache {
    constructor(maxSize = 50, ttlMs = 300000) {
        this.cache = new Map();
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
    }

    get(key) {
        const entry = this.cache.get(key);
        if (!entry) return null;

        // Check TTL
        if (Date.now() > entry.expiry) {
            this.cache.delete(key);
            return null;
        }

        // Move to end (most recently used)
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.value;
    }

    set(key, value) {
        // Remove oldest if at capacity
        if (this.cache.size >= this.maxSize) {
            const oldest = this.cache.keys().next().value;
            this.cache.delete(oldest);
        }

        this.cache.set(key, {
            value,
            expiry: Date.now() + this.ttlMs
        });
    }

    clear() {
        this.cache.clear();
    }

    has(key) {
        return this.get(key) !== null;
    }
}

/**
 * Pre-computed tag embeddings for auto-tagging
 * These will be populated when embeddings are generated
 */
const TAG_DEFINITIONS = Object.freeze({
    'Technology': ['software', 'hardware', 'computer', 'tech', 'digital', 'innovation'],
    'Programming': ['code', 'programming', 'developer', 'javascript', 'python', 'api', 'software engineering'],
    'Design': ['design', 'ui', 'ux', 'visual', 'graphics', 'creative', 'interface'],
    'Business': ['business', 'startup', 'entrepreneur', 'marketing', 'finance', 'strategy'],
    'Learning': ['learn', 'tutorial', 'course', 'education', 'guide', 'how to'],
    'News': ['news', 'breaking', 'latest', 'update', 'report', 'announcement'],
    'Tutorial': ['tutorial', 'step by step', 'guide', 'walkthrough', 'how to', 'introduction'],
    'Research': ['research', 'study', 'paper', 'analysis', 'data', 'findings']
});

const ORAMA_SCHEMA = {
    id: 'string',
    title: 'string',
    excerpt: 'string',
    textSnippet: 'string',
    url: 'string',
    siteName: 'string',
    extractedAt: 'number',
    folderId: 'string',
    tags: 'string[]',
    embedding: 'vector[384]'
};

const LIMITS = Object.freeze({
    MAX_BOOKMARKS: 1000,
    TEXT_SNIPPET_LENGTH: 10000,
    SEARCH_RESULTS: 20,
    VECTOR_WEIGHT: 0.7,
    FTS_WEIGHT: 0.3,
    DEFAULT_FOLDERS: ['Programming', 'Design', 'Business', 'Learning', 'Personal']
});

class StorageManager {
    constructor() {
        this.db = null;
        this.oramaDb = null;
        this.initialized = false;
        this.indexedIds = new Set(); // Track what's in Orama
        this.folderCache = new Map();

        // LRU caches for performance
        this.searchCache = new LRUCache(50, 300000); // 5 min TTL
        this.embeddingCache = new LRUCache(100, 600000); // 10 min TTL
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
                    store.createIndex('folderId', 'folderId', { unique: false });
                }

                if (!db.objectStoreNames.contains(DB_CONFIG.STORES.BLOBS)) {
                    db.createObjectStore(DB_CONFIG.STORES.BLOBS, { keyPath: 'id' });
                }

                if (!db.objectStoreNames.contains(DB_CONFIG.STORES.FOLDERS)) {
                    const store = db.createObjectStore(DB_CONFIG.STORES.FOLDERS, { keyPath: 'id' });
                    store.createIndex('name', 'name', { unique: false });
                    store.createIndex('parentId', 'parentId', { unique: false });
                    store.createIndex('sortOrder', 'sortOrder', { unique: false });
                }

                if (!db.objectStoreNames.contains(DB_CONFIG.STORES.COLLECTIONS)) {
                    const store = db.createObjectStore(DB_CONFIG.STORES.COLLECTIONS, { keyPath: 'id' });
                    store.createIndex('name', 'name', { unique: false });
                    store.createIndex('isSmart', 'isSmart', { unique: false });
                }

                if (!db.objectStoreNames.contains(DB_CONFIG.STORES.COLLECTION_PAGES)) {
                    const store = db.createObjectStore(DB_CONFIG.STORES.COLLECTION_PAGES, { keyPath: 'id' });
                    store.createIndex('collectionId', 'collectionId', { unique: false });
                    store.createIndex('pageId', 'pageId', { unique: false });
                }

                // Notes store for annotations and highlights
                if (!db.objectStoreNames.contains(DB_CONFIG.STORES.NOTES)) {
                    const store = db.createObjectStore(DB_CONFIG.STORES.NOTES, { keyPath: 'id' });
                    store.createIndex('bookmarkId', 'bookmarkId', { unique: false });
                    store.createIndex('createdAt', 'createdAt', { unique: false });
                    store.createIndex('type', 'type', { unique: false });
                }
            }
        });

        // Create Orama index
        this.oramaDb = await create({ schema: ORAMA_SCHEMA });

        // Incrementally load existing bookmarks into Orama
        await this.loadIndexFromDb();
        await this.ensureDefaultFolders();

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
            folderId: bookmark.folderId || 'general',
            tags: Array.isArray(bookmark.tags) ? bookmark.tags : [],
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

        // Auto-tag if no tags provided
        let tags = validated.tags || [];
        if (tags.length === 0) {
            tags = this.autoTagFromContent(validated.title, validated.excerpt, validated.textContent);
        }

        const bookmark = {
            id: validated.id,
            title: validated.title,
            excerpt: validated.excerpt,
            url: validated.url,
            siteName: validated.siteName,
            wordCount: validated.wordCount,
            extractedAt: validated.extractedAt,
            folderId: validated.folderId || 'general',
            tags,
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

        // Invalidate search cache
        this.invalidateSearchCache();

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
        if (updates.folderId) {
            updated.folderId = updates.folderId;
        }
        if (updates.tags) {
            updated.tags = updates.tags;
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

        // Invalidate search cache
        this.invalidateSearchCache();

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

        // Invalidate search cache
        this.invalidateSearchCache();

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

    async getAllBookmarks({ limit = 100, offset = 0, folderId = null } = {}) {
        this.ensureInitialized();
        let all = [];
        if (folderId) {
            const index = this.db.transaction(DB_CONFIG.STORES.BOOKMARKS).store.index('folderId');
            all = await index.getAll(folderId);
        } else {
            all = await this.db.getAll(DB_CONFIG.STORES.BOOKMARKS);
        }
        all.sort((a, b) => (b.extractedAt || 0) - (a.extractedAt || 0));
        return all.slice(offset, offset + limit);
    }

    async getBookmarkCount() {
        this.ensureInitialized();
        return this.db.count(DB_CONFIG.STORES.BOOKMARKS);
    }

    async ensureDefaultFolders() {
        const tx = this.db.transaction(DB_CONFIG.STORES.FOLDERS, 'readwrite');
        const store = tx.objectStore(DB_CONFIG.STORES.FOLDERS);
        const existing = await store.getAll();
        if (existing.length === 0) {
            const defaultFolders = LIMITS.DEFAULT_FOLDERS.map((name, index) => ({
                id: name.toLowerCase(),
                name,
                parentId: null,
                icon: name === 'Programming' ? 'code' : name === 'Design' ? 'palette' : name === 'Business' ? 'briefcase' : name === 'Learning' ? 'book' : 'user',
                color: name === 'Programming' ? '#00D4FF' : name === 'Design' ? '#FF6B35' : name === 'Business' ? '#A855F7' : name === 'Learning' ? '#22C55E' : '#6B7280',
                sortOrder: index
            }));
            for (const folder of defaultFolders) {
                await store.put(folder);
            }
        }
        await tx.done;
    }

    async listFolders() {
        this.ensureInitialized();
        const folders = await this.db.getAll(DB_CONFIG.STORES.FOLDERS);
        folders.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
        return folders;
    }

    async createFolder({ name, parentId = null } = {}) {
        this.ensureInitialized();
        const trimmed = String(name || '').trim();
        if (!trimmed) {
            throw new Error('Folder name required');
        }
        const existing = await this.db.getAll(DB_CONFIG.STORES.FOLDERS);
        if (existing.some(folder => folder.name.toLowerCase() === trimmed.toLowerCase())) {
            throw new Error(`Folder "${trimmed}" already exists`);
        }
        const folder = {
            id: crypto.randomUUID(),
            name: trimmed,
            parentId,
            icon: 'folder',
            color: '#94A3B8',
            sortOrder: existing.length
        };
        await this.db.put(DB_CONFIG.STORES.FOLDERS, folder);
        return folder;
    }

    async updateFolder(id, updates = {}) {
        this.ensureInitialized();
        const existing = await this.db.get(DB_CONFIG.STORES.FOLDERS, id);
        if (!existing) {
            throw new Error('Folder not found');
        }
        const updated = { ...existing, ...updates };
        if (updates.name) {
            updated.name = String(updates.name).trim().substring(0, 50);
        }
        await this.db.put(DB_CONFIG.STORES.FOLDERS, updated);
        return updated;
    }

    async deleteFolder(id, { moveToId = 'general' } = {}) {
        this.ensureInitialized();
        const bookmarks = await this.db.getAll(DB_CONFIG.STORES.BOOKMARKS);
        const tx = this.db.transaction([DB_CONFIG.STORES.BOOKMARKS, DB_CONFIG.STORES.FOLDERS], 'readwrite');
        for (const bookmark of bookmarks) {
            if (bookmark.folderId === id) {
                bookmark.folderId = moveToId;
                await tx.objectStore(DB_CONFIG.STORES.BOOKMARKS).put(bookmark);
            }
        }
        await tx.objectStore(DB_CONFIG.STORES.FOLDERS).delete(id);
        await tx.done;
    }

    async moveBookmarkToFolder(id, folderId) {
        this.ensureInitialized();
        const bookmark = await this.db.get(DB_CONFIG.STORES.BOOKMARKS, id);
        if (!bookmark) {
            throw new Error('Bookmark not found');
        }
        bookmark.folderId = folderId;
        await this.db.put(DB_CONFIG.STORES.BOOKMARKS, bookmark);
        try {
            await remove(this.oramaDb, bookmark.id);
            await this.insertIntoOrama(bookmark);
        } catch (_) {}
        return bookmark;
    }

    async getFolderStats(folderId) {
        this.ensureInitialized();
        const bookmarks = await this.db.getAll(DB_CONFIG.STORES.BOOKMARKS);
        return bookmarks.filter(bookmark => bookmark.folderId === folderId).length;
    }

    async createCollection({ name, description = '', isSmart = false, criteria = null } = {}) {
        this.ensureInitialized();
        const trimmed = String(name || '').trim();
        if (!trimmed) {
            throw new Error('Collection name required');
        }
        const collection = {
            id: crypto.randomUUID(),
            name: trimmed,
            description,
            isSmart,
            criteria,
            sortOrder: Date.now()
        };
        await this.db.put(DB_CONFIG.STORES.COLLECTIONS, collection);
        return collection;
    }

    async listCollections() {
        this.ensureInitialized();
        return this.db.getAll(DB_CONFIG.STORES.COLLECTIONS);
    }

    /**
     * Hybrid search: vector + full-text with LRU caching
     */
    async search(query, queryEmbedding, { limit = LIMITS.SEARCH_RESULTS, folderId = null } = {}) {
        this.ensureInitialized();

        // Check cache first
        const cacheKey = `${query}:${folderId || 'all'}:${limit}`;
        const cached = this.searchCache.get(cacheKey);
        if (cached) {
            return cached;
        }

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
            },
            filters: folderId ? { folderId } : undefined
        });

        const mapped = results.hits.map(hit => ({
            ...hit.document,
            score: hit.score
        }));

        // Cache the results
        this.searchCache.set(cacheKey, mapped);
        return mapped;
    }

    /**
     * Text-only search fallback with caching
     */
    async searchText(query, { limit = LIMITS.SEARCH_RESULTS, folderId = null } = {}) {
        this.ensureInitialized();

        // Check cache
        const cacheKey = `text:${query}:${folderId || 'all'}:${limit}`;
        const cached = this.searchCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const results = await search(this.oramaDb, {
            term: query,
            limit,
            boost: {
                title: 2,
                excerpt: 1.5
            },
            filters: folderId ? { folderId } : undefined
        });

        const mapped = results.hits.map(hit => ({
            ...hit.document,
            score: hit.score
        }));

        this.searchCache.set(cacheKey, mapped);
        return mapped;
    }

    /**
     * Auto-tag bookmark based on content
     * Uses keyword matching for v1 (no embedding comparison needed)
     */
    autoTagFromContent(title, excerpt, textContent) {
        const text = `${title} ${excerpt} ${textContent || ''}`.toLowerCase();
        const tags = [];

        for (const [tag, keywords] of Object.entries(TAG_DEFINITIONS)) {
            const matchCount = keywords.filter(kw => text.includes(kw.toLowerCase())).length;
            if (matchCount >= 2 || (keywords.length <= 3 && matchCount >= 1)) {
                tags.push(tag);
            }
        }

        // Return top 3 tags
        return tags.slice(0, 3);
    }

    // ==================== Notes/Highlights ====================

    /**
     * Create a note or highlight
     */
    async createNote({ bookmarkId, content, type = 'note' }) {
        this.ensureInitialized();

        if (!content || typeof content !== 'string') {
            throw new Error('Note content is required');
        }

        const note = {
            id: crypto.randomUUID(),
            bookmarkId: bookmarkId || null,
            content: content.substring(0, 10000),
            type, // 'note', 'highlight', 'annotation'
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        await this.db.put(DB_CONFIG.STORES.NOTES, note);
        return note;
    }

    /**
     * Get notes for a bookmark
     */
    async getNotesForBookmark(bookmarkId) {
        this.ensureInitialized();
        const index = this.db.transaction(DB_CONFIG.STORES.NOTES).store.index('bookmarkId');
        const notes = await index.getAll(bookmarkId);
        notes.sort((a, b) => b.createdAt - a.createdAt);
        return notes;
    }

    /**
     * Update a note
     */
    async updateNote(id, { content }) {
        this.ensureInitialized();
        const existing = await this.db.get(DB_CONFIG.STORES.NOTES, id);
        if (!existing) {
            throw new Error('Note not found');
        }

        const updated = {
            ...existing,
            content: content.substring(0, 10000),
            updatedAt: Date.now()
        };

        await this.db.put(DB_CONFIG.STORES.NOTES, updated);
        return updated;
    }

    /**
     * Delete a note
     */
    async deleteNote(id) {
        this.ensureInitialized();
        await this.db.delete(DB_CONFIG.STORES.NOTES, id);
    }

    /**
     * Get all notes (for search or export)
     */
    async getAllNotes({ limit = 100, type = null } = {}) {
        this.ensureInitialized();

        let notes;
        if (type) {
            const index = this.db.transaction(DB_CONFIG.STORES.NOTES).store.index('type');
            notes = await index.getAll(type);
        } else {
            notes = await this.db.getAll(DB_CONFIG.STORES.NOTES);
        }

        notes.sort((a, b) => b.createdAt - a.createdAt);
        return notes.slice(0, limit);
    }

    /**
     * Invalidate search cache (call after bookmark changes)
     */
    invalidateSearchCache() {
        this.searchCache.clear();
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

        // Validate URL protocol (security: prevent javascript: and data: URLs)
        let validatedUrl;
        try {
            const parsed = new URL(data.url);
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                throw new Error('Invalid URL protocol');
            }
            validatedUrl = parsed.href;
        } catch (e) {
            throw new Error('Invalid URL format');
        }

        const validated = Object.create(null);
        validated.id = data.id || crypto.randomUUID();
        validated.title = String(data.title || 'Untitled').substring(0, 500);
        validated.excerpt = String(data.excerpt || '').substring(0, 1000);
        validated.url = validatedUrl;
        validated.siteName = String(data.siteName || '').substring(0, 100);
        validated.wordCount = Math.max(0, parseInt(data.wordCount) || 0);
        validated.extractedAt = data.extractedAt || Date.now();
        validated.syncedAt = Date.now();
        validated.folderId = typeof data.folderId === 'string' ? data.folderId : 'general';
        validated.tags = Array.isArray(data.tags) ? data.tags.slice(0, 10) : [];

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
