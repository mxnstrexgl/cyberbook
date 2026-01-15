// popup.js - Cyberbook popup UI

document.addEventListener('DOMContentLoaded', init);

async function init() {
    const saveBtn = document.getElementById('saveBookmarkBtn');
    const searchInput = document.getElementById('searchQuery');
    const statusEl = document.getElementById('status');
    const resultsEl = document.getElementById('searchResults');
    const countEl = document.getElementById('bookmarkCount');
    const recentSection = document.getElementById('recentSection');
    const recentList = document.getElementById('recentList');

    let searchTimeout = null;

    // Load stats and recent bookmarks
    await loadStats();
    await loadRecent();

    // Save button
    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        showStatus('Extracting content...', 'loading');

        try {
            // Get current tab
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) throw new Error('No active tab');

            // Extract content from page
            const content = await chrome.tabs.sendMessage(tab.id, { action: 'EXTRACT_CONTENT' });
            if (!content.success) throw new Error('Failed to extract content');

            showStatus('Saving bookmark...', 'loading');

            // Save to background
            const response = await chrome.runtime.sendMessage({
                action: 'SAVE_BOOKMARK',
                title: content.title,
                url: content.url,
                siteName: content.siteName,
                textContent: content.textContent,
                wordCount: content.wordCount,
                excerpt: content.excerpt
            });

            if (response.success) {
                showStatus('Saved!', 'success');
                await loadStats();
                await loadRecent();
            } else {
                throw new Error(response.error || 'Save failed');
            }

        } catch (error) {
            console.error('[Cyberbook] Save error:', error);
            showStatus(error.message || 'Failed to save', 'error');
        } finally {
            saveBtn.disabled = false;
        }
    });

    // Search with debounce
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        const query = searchInput.value.trim();

        if (!query) {
            loadRecent();
            return;
        }

        searchTimeout = setTimeout(() => {
            performSearch(query);
        }, 300);
    });

    async function performSearch(query) {
        showStatus('Searching...', 'loading');
        recentSection.classList.add('hidden');

        try {
            const response = await chrome.runtime.sendMessage({
                action: 'SEARCH_BOOKMARKS',
                query,
                limit: 20
            });

            hideStatus();

            if (response.success) {
                renderResults(response.results);
            } else {
                throw new Error(response.error);
            }

        } catch (error) {
            console.error('[Cyberbook] Search error:', error);
            showStatus('Search failed', 'error');
        }
    }

    async function loadStats() {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'GET_BOOKMARK_STATS'
            });

            if (response.success) {
                countEl.textContent = `${response.stats.bookmarkCount} bookmark${response.stats.bookmarkCount !== 1 ? 's' : ''}`;
            }
        } catch (error) {
            console.error('[Cyberbook] Stats error:', error);
        }
    }

    async function loadRecent() {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'GET_ALL_BOOKMARKS',
                limit: 10,
                offset: 0
            });

            if (response.success && response.bookmarks.length > 0) {
                recentSection.classList.remove('hidden');
                renderBookmarks(recentList, response.bookmarks);
                resultsEl.innerHTML = '';
            } else {
                recentSection.classList.add('hidden');
                resultsEl.innerHTML = `
                    <div class="empty-state">
                        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
                            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
                        </svg>
                        <p>No bookmarks yet</p>
                        <p class="muted">Save pages to search them by meaning</p>
                    </div>
                `;
            }
        } catch (error) {
            console.error('[Cyberbook] Load recent error:', error);
        }
    }

    function renderResults(results) {
        recentSection.classList.add('hidden');

        if (!results || results.length === 0) {
            resultsEl.innerHTML = `
                <div class="empty-state">
                    <p>No results found</p>
                    <p class="muted">Try different search terms</p>
                </div>
            `;
            return;
        }

        renderBookmarks(resultsEl, results, true);
    }

    function renderBookmarks(container, bookmarks, showScore = false) {
        container.innerHTML = bookmarks.map(bookmark => `
            <div class="bookmark-item" data-id="${bookmark.id}" data-url="${bookmark.url}">
                <div class="bookmark-content">
                    <div class="bookmark-title">${escapeHtml(bookmark.title)}</div>
                    <div class="bookmark-excerpt">${escapeHtml(bookmark.excerpt || '')}</div>
                    <div class="bookmark-meta">
                        <span class="bookmark-site">${escapeHtml(bookmark.siteName || '')}</span>
                        <span>${formatTime(bookmark.extractedAt)}</span>
                        ${showScore && bookmark.score ? `<span class="bookmark-score">${Math.round(bookmark.score * 100)}%</span>` : ''}
                    </div>
                </div>
                <button class="bookmark-delete" title="Delete bookmark">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
        `).join('');

        // Add click handlers
        container.querySelectorAll('.bookmark-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.bookmark-delete')) return;
                const url = item.dataset.url;
                if (url) chrome.tabs.create({ url });
            });
        });

        container.querySelectorAll('.bookmark-delete').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const item = btn.closest('.bookmark-item');
                const id = item.dataset.id;

                try {
                    await chrome.runtime.sendMessage({
                        action: 'DELETE_BOOKMARK',
                        id
                    });
                    item.remove();
                    await loadStats();
                } catch (error) {
                    console.error('[Cyberbook] Delete error:', error);
                }
            });
        });
    }

    function showStatus(message, type) {
        statusEl.textContent = message;
        statusEl.className = `status visible ${type}`;
    }

    function hideStatus() {
        statusEl.className = 'status';
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function formatTime(timestamp) {
        if (!timestamp) return '';
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;

        if (diff < 60000) return 'Just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

        return date.toLocaleDateString();
    }
}
