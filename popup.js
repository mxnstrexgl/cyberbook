// popup.js - Stash popup UI with folders, autocomplete, and toast notifications

document.addEventListener('DOMContentLoaded', init);

// State
let currentFolderId = '';
let folders = [];
let recentSearches = JSON.parse(localStorage.getItem('stashRecentSearches') || '[]');
let autocompleteTimeout = null;
let selectedAutocompleteIndex = -1;

async function init() {
    const saveBtn = document.getElementById('saveBookmarkBtn');
    const searchInput = document.getElementById('searchQuery');
    const resultsEl = document.getElementById('searchResults');
    const countEl = document.getElementById('bookmarkCount');
    const recentSection = document.getElementById('recentSection');
    const recentList = document.getElementById('recentList');
    const folderList = document.getElementById('folderList');
    const newFolderBtn = document.getElementById('newFolderBtn');
    const folderModal = document.getElementById('folderModal');
    const folderNameInput = document.getElementById('folderNameInput');
    const createFolderBtn = document.getElementById('createFolderBtn');
    const cancelFolderBtn = document.getElementById('cancelFolderBtn');
    const autocompleteList = document.getElementById('autocompleteList');

    let searchTimeout = null;

    // Load initial data
    await loadFolders();
    await loadStats();
    await loadRecent();

    // Save button
    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;

        try {
            // Get current tab
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) throw new Error('No active tab');

            showToast('Extracting content...', 'info');

            // Extract content from page
            const content = await chrome.tabs.sendMessage(tab.id, { action: 'EXTRACT_CONTENT' });
            if (!content.success) throw new Error('Failed to extract content');

            // Save to background
            const response = await chrome.runtime.sendMessage({
                action: 'SAVE_BOOKMARK',
                title: content.title,
                url: content.url,
                siteName: content.siteName,
                textContent: content.textContent,
                wordCount: content.wordCount,
                excerpt: content.excerpt,
                folderId: currentFolderId || 'general'
            });

            if (response.success) {
                showToast('Saved!', 'success');
                await loadStats();
                await loadRecent();
            } else {
                throw new Error(response.error || 'Save failed');
            }

        } catch (error) {
            console.error('[Stash] Save error:', error);
            showToast(error.message || 'Failed to save', 'error');
        } finally {
            saveBtn.disabled = false;
        }
    });

    // Search with debounce and autocomplete
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        clearTimeout(autocompleteTimeout);
        const query = searchInput.value.trim();

        if (!query) {
            hideAutocomplete();
            loadRecent();
            return;
        }

        // Show autocomplete suggestions
        if (query.length >= 2) {
            autocompleteTimeout = setTimeout(() => {
                showAutocomplete(query);
            }, 150);
        }

        searchTimeout = setTimeout(() => {
            performSearch(query);
        }, 300);
    });

    // Autocomplete keyboard navigation
    searchInput.addEventListener('keydown', (e) => {
        const items = autocompleteList.querySelectorAll('.autocomplete-item');
        if (items.length === 0) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedAutocompleteIndex = Math.min(selectedAutocompleteIndex + 1, items.length - 1);
            updateAutocompleteSelection(items);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedAutocompleteIndex = Math.max(selectedAutocompleteIndex - 1, 0);
            updateAutocompleteSelection(items);
        } else if (e.key === 'Enter' && selectedAutocompleteIndex >= 0) {
            e.preventDefault();
            const selectedItem = items[selectedAutocompleteIndex];
            if (selectedItem) {
                searchInput.value = selectedItem.dataset.query;
                hideAutocomplete();
                performSearch(selectedItem.dataset.query);
            }
        } else if (e.key === 'Escape') {
            hideAutocomplete();
        }
    });

    // Hide autocomplete on click outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-box')) {
            hideAutocomplete();
        }
    });

    // Folder click handlers
    folderList.addEventListener('click', async (e) => {
        const folderItem = e.target.closest('.folder-item');
        if (!folderItem) return;

        const folderId = folderItem.dataset.folderId;
        currentFolderId = folderId;

        // Update active state
        folderList.querySelectorAll('.folder-item').forEach(item => {
            item.classList.toggle('active', item.dataset.folderId === folderId);
        });

        await loadRecent();
    });

    // New folder button
    newFolderBtn.addEventListener('click', () => {
        folderModal.classList.remove('hidden');
        folderNameInput.value = '';
        folderNameInput.focus();
    });

    // Cancel folder creation
    cancelFolderBtn.addEventListener('click', () => {
        folderModal.classList.add('hidden');
    });

    // Create folder
    createFolderBtn.addEventListener('click', async () => {
        const name = folderNameInput.value.trim();
        if (!name) return;

        try {
            const response = await chrome.runtime.sendMessage({
                action: 'CREATE_FOLDER',
                name
            });

            if (response.success) {
                folderModal.classList.add('hidden');
                await loadFolders();
                showToast(`Folder "${name}" created`, 'success');
            } else {
                throw new Error(response.error);
            }
        } catch (error) {
            showToast(error.message || 'Failed to create folder', 'error');
        }
    });

    // Enter key in folder name input
    folderNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            createFolderBtn.click();
        } else if (e.key === 'Escape') {
            folderModal.classList.add('hidden');
        }
    });

    // Click outside modal to close
    folderModal.addEventListener('click', (e) => {
        if (e.target === folderModal) {
            folderModal.classList.add('hidden');
        }
    });

    async function loadFolders() {
        try {
            const response = await chrome.runtime.sendMessage({ action: 'LIST_FOLDERS' });
            if (response.success) {
                folders = response.folders;
                renderFolders();
            }
        } catch (error) {
            console.error('[Stash] Load folders error:', error);
        }
    }

    function renderFolders() {
        // Keep the "All" item
        const allItem = folderList.querySelector('[data-folder-id=""]');

        // Clear and rebuild
        folderList.innerHTML = '';
        folderList.appendChild(allItem);

        // Add folders
        folders.forEach(folder => {
            const li = document.createElement('li');
            li.className = `folder-item${folder.id === currentFolderId ? ' active' : ''}`;
            li.dataset.folderId = folder.id;
            li.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${folder.color || 'currentColor'}" stroke-width="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                </svg>
                <span>${escapeHtml(folder.name)}</span>
            `;
            folderList.appendChild(li);
        });
    }

    async function performSearch(query) {
        recentSection.classList.add('hidden');

        try {
            const response = await chrome.runtime.sendMessage({
                action: 'SEARCH_BOOKMARKS',
                query,
                limit: 20
            });

            if (response.success) {
                renderResults(response.results);
                // Save to recent searches
                addRecentSearch(query);
            } else {
                throw new Error(response.error);
            }

        } catch (error) {
            console.error('[Stash] Search error:', error);
            showToast('Search failed', 'error');
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
            console.error('[Stash] Stats error:', error);
        }
    }

    async function loadRecent() {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'GET_ALL_BOOKMARKS',
                limit: 10,
                offset: 0,
                folderId: currentFolderId || null
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
            console.error('[Stash] Load recent error:', error);
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
            <div class="bookmark-item" data-id="${escapeHtml(bookmark.id)}" data-url="${escapeHtml(bookmark.url)}">
                <div class="bookmark-content">
                    <div class="bookmark-title">${escapeHtml(bookmark.title)}</div>
                    <div class="bookmark-excerpt">${escapeHtml(bookmark.excerpt || '')}</div>
                    ${bookmark.tags && bookmark.tags.length > 0 ? `
                        <div class="bookmark-tags">
                            ${bookmark.tags.slice(0, 3).map(tag => `<span class="bookmark-tag">${escapeHtml(tag)}</span>`).join('')}
                        </div>
                    ` : ''}
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
                    showToast('Bookmark deleted', 'info');
                } catch (error) {
                    console.error('[Stash] Delete error:', error);
                    showToast('Failed to delete', 'error');
                }
            });
        });
    }

    function showAutocomplete(query) {
        // Get suggestions from recent searches and bookmark titles
        const queryLower = query.toLowerCase();
        const suggestions = recentSearches
            .filter(s => s.toLowerCase().includes(queryLower) && s !== query)
            .slice(0, 5);

        if (suggestions.length === 0) {
            hideAutocomplete();
            return;
        }

        autocompleteList.innerHTML = suggestions.map(suggestion => `
            <div class="autocomplete-item" data-query="${escapeHtml(suggestion)}">
                ${highlightMatch(suggestion, query)}
            </div>
        `).join('');

        autocompleteList.classList.remove('hidden');
        selectedAutocompleteIndex = -1;

        // Add click handlers
        autocompleteList.querySelectorAll('.autocomplete-item').forEach(item => {
            item.addEventListener('click', () => {
                searchInput.value = item.dataset.query;
                hideAutocomplete();
                performSearch(item.dataset.query);
            });
        });
    }

    function hideAutocomplete() {
        autocompleteList.classList.add('hidden');
        selectedAutocompleteIndex = -1;
    }

    function updateAutocompleteSelection(items) {
        items.forEach((item, index) => {
            item.classList.toggle('selected', index === selectedAutocompleteIndex);
        });
    }

    function highlightMatch(text, query) {
        const index = text.toLowerCase().indexOf(query.toLowerCase());
        if (index === -1) return escapeHtml(text);

        const before = text.substring(0, index);
        const match = text.substring(index, index + query.length);
        const after = text.substring(index + query.length);

        return `${escapeHtml(before)}<span class="match">${escapeHtml(match)}</span>${escapeHtml(after)}`;
    }

    function addRecentSearch(query) {
        const trimmed = query.trim();
        if (!trimmed || trimmed.length < 2) return;

        // Remove if exists and add to front
        recentSearches = recentSearches.filter(s => s !== trimmed);
        recentSearches.unshift(trimmed);

        // Keep only last 20
        recentSearches = recentSearches.slice(0, 20);
        localStorage.setItem('stashRecentSearches', JSON.stringify(recentSearches));
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

// Toast notification system
function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
        toast.classList.add('visible');
    });

    // Remove after duration
    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// Make showToast available globally
window.showToast = showToast;
