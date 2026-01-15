// popup.js - Cyberbook Popup UI

(function (global) {
    'use strict';

    const CONFIG = Object.freeze({
        DEBOUNCE_MS: 300,
        MIN_QUERY_LENGTH: 2,
        RECENT_LIMIT: 10,
        STATUS_TIMEOUT_MS: 3000
    });

    let searchDebounceTimer = null;
    let currentTab = null;
    let isSearching = false;

    const elements = {
        saveBookmarkBtn: null,
        bookmarkStatus: null,
        searchQuery: null,
        searchResults: null,
        recentBookmarks: null,
        recentList: null,
        bookmarkCount: null,
        bookmarkLimit: null
    };

    async function initialize() {
        elements.saveBookmarkBtn = document.getElementById('saveBookmarkBtn');
        elements.bookmarkStatus = document.getElementById('bookmarkStatus');
        elements.searchQuery = document.getElementById('searchQuery');
        elements.searchResults = document.getElementById('searchResults');
        elements.recentBookmarks = document.getElementById('recentBookmarks');
        elements.recentList = document.getElementById('recentList');
        elements.bookmarkCount = document.getElementById('bookmarkCount');
        elements.bookmarkLimit = document.getElementById('bookmarkLimit');

        setupEventListeners();

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            currentTab = tab;
        } catch (error) {
            console.error('[Cyberbook] Failed to get current tab:', error);
        }

        await loadBookmarkData();

        console.log('[Cyberbook] Popup initialized');
    }

    function setupEventListeners() {
        elements.saveBookmarkBtn?.addEventListener('click', handleSaveBookmark);

        elements.searchQuery?.addEventListener('input', handleSearchInput);
        elements.searchQuery?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleSearchInput(e);
            }
        });
    }

    async function loadBookmarkData() {
        try {
            const statsResponse = await sendMessage({ action: 'GET_BOOKMARK_STATS' });

            if (statsResponse?.success && statsResponse.stats) {
                const { bookmarkCount, maxBookmarks } = statsResponse.stats;
                updateStats(bookmarkCount, maxBookmarks);
            }

            const recentResponse = await sendMessage({
                action: 'GET_ALL_BOOKMARKS',
                limit: CONFIG.RECENT_LIMIT
            });

            if (recentResponse?.success && recentResponse.bookmarks) {
                displayRecentBookmarks(recentResponse.bookmarks);
            }

        } catch (error) {
            console.error('[Cyberbook] Failed to load bookmark data:', error);
        }
    }

    function updateStats(count, max) {
        if (elements.bookmarkCount) {
            elements.bookmarkCount.textContent = `${count} bookmark${count !== 1 ? 's' : ''}`;
        }
        if (elements.bookmarkLimit) {
            elements.bookmarkLimit.textContent = `${max} max`;
        }
    }

    function displayRecentBookmarks(bookmarks) {
        if (!elements.recentList) return;

        elements.recentList.textContent = '';

        if (bookmarks.length === 0) {
            elements.recentBookmarks?.classList.add('hidden');
            return;
        }

        elements.recentBookmarks?.classList.remove('hidden');

        bookmarks.forEach(bookmark => {
            const item = createBookmarkItemElement(bookmark);
            elements.recentList.appendChild(item);
        });
    }

    async function handleSaveBookmark() {
        if (!currentTab) {
            showStatus('error', 'Could not get current tab');
            return;
        }

        elements.saveBookmarkBtn.disabled = true;
        elements.saveBookmarkBtn.textContent = 'Saving...';

        try {
            const response = await sendMessage({
                action: 'SAVE_BOOKMARK',
                tabId: currentTab.id
            });

            if (response?.success) {
                showStatus('success', `Saved: ${response.title || 'Page saved'}`);
                await loadBookmarkData();
            } else {
                showStatus('error', response?.error || 'Failed to save bookmark');
            }

        } catch (error) {
            console.error('[Cyberbook] Save error:', error);
            showStatus('error', 'Failed to save bookmark');

        } finally {
            elements.saveBookmarkBtn.disabled = false;
            elements.saveBookmarkBtn.textContent = 'Save This Page';
        }
    }

    function handleSearchInput(event) {
        const query = event.target.value.trim();

        if (searchDebounceTimer) {
            clearTimeout(searchDebounceTimer);
        }

        if (query.length < CONFIG.MIN_QUERY_LENGTH) {
            hideSearchResults();
            return;
        }

        searchDebounceTimer = setTimeout(() => {
            performSearch(query);
        }, CONFIG.DEBOUNCE_MS);
    }

    async function performSearch(query) {
        if (isSearching) return;

        isSearching = true;
        showSearchLoading();

        try {
            const response = await sendMessage({
                action: 'SEARCH_BOOKMARKS',
                query: query,
                limit: 20
            });

            if (response?.success) {
                displaySearchResults(response.results, query);
            } else {
                showSearchError(response?.error || 'Search failed');
            }

        } catch (error) {
            console.error('[Cyberbook] Search error:', error);
            showSearchError('Search failed');

        } finally {
            isSearching = false;
        }
    }

    function displaySearchResults(results, query) {
        if (!elements.searchResults) return;

        elements.searchResults.textContent = '';
        elements.recentBookmarks?.classList.add('hidden');

        if (results.length === 0) {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'bookmark-empty';

            const p1 = document.createElement('p');
            p1.textContent = `No results for "${query}"`;
            emptyDiv.appendChild(p1);

            const p2 = document.createElement('p');
            p2.className = 'text-sm text-muted';
            p2.textContent = 'Try different keywords';
            emptyDiv.appendChild(p2);

            elements.searchResults.appendChild(emptyDiv);
            return;
        }

        const header = document.createElement('div');
        header.className = 'search-header';
        const headerSpan = document.createElement('span');
        headerSpan.className = 'text-sm text-muted';
        headerSpan.textContent = `${results.length} result${results.length !== 1 ? 's' : ''}`;
        header.appendChild(headerSpan);
        elements.searchResults.appendChild(header);

        results.forEach(result => {
            const item = createBookmarkItemElement(result, true);
            elements.searchResults.appendChild(item);
        });
    }

    function hideSearchResults() {
        if (elements.searchResults) {
            elements.searchResults.textContent = '';

            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'bookmark-empty';

            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('width', '32');
            svg.setAttribute('height', '32');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '1');
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z');
            svg.appendChild(path);
            emptyDiv.appendChild(svg);

            const p1 = document.createElement('p');
            p1.textContent = 'Search by meaning';
            emptyDiv.appendChild(p1);

            const p2 = document.createElement('p');
            p2.className = 'text-sm text-muted';
            p2.textContent = 'Type to find related pages';
            emptyDiv.appendChild(p2);

            elements.searchResults.appendChild(emptyDiv);
        }
        elements.recentBookmarks?.classList.remove('hidden');
    }

    function showSearchLoading() {
        if (elements.searchResults) {
            elements.searchResults.textContent = '';

            const loadingDiv = document.createElement('div');
            loadingDiv.className = 'search-loading';

            const spinner = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            spinner.setAttribute('class', 'spinner');
            spinner.setAttribute('width', '24');
            spinner.setAttribute('height', '24');
            spinner.setAttribute('viewBox', '0 0 24 24');
            spinner.setAttribute('fill', 'none');
            spinner.setAttribute('stroke', 'currentColor');
            spinner.setAttribute('stroke-width', '2');
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', '12');
            circle.setAttribute('cy', '12');
            circle.setAttribute('r', '10');
            circle.setAttribute('stroke-dasharray', '31.4');
            circle.setAttribute('stroke-dashoffset', '10');
            spinner.appendChild(circle);
            loadingDiv.appendChild(spinner);

            const p = document.createElement('p');
            p.className = 'text-sm text-muted';
            p.textContent = 'Searching...';
            loadingDiv.appendChild(p);

            elements.searchResults.appendChild(loadingDiv);
        }
    }

    function showSearchError(message) {
        if (elements.searchResults) {
            elements.searchResults.textContent = '';

            const errorDiv = document.createElement('div');
            errorDiv.className = 'bookmark-empty bookmark-error';

            const p1 = document.createElement('p');
            p1.textContent = 'Search error';
            errorDiv.appendChild(p1);

            const p2 = document.createElement('p');
            p2.className = 'text-sm text-muted';
            p2.textContent = message;
            errorDiv.appendChild(p2);

            elements.searchResults.appendChild(errorDiv);
        }
    }

    function handleBookmarkClick(url) {
        if (!url) return;
        chrome.tabs.create({ url });
        window.close();
    }

    async function handleDeleteBookmark(id) {
        if (!id) return;

        try {
            const response = await sendMessage({
                action: 'DELETE_BOOKMARK',
                id: id
            });

            if (response?.success) {
                showStatus('success', 'Bookmark deleted');
                await loadBookmarkData();

                const query = elements.searchQuery?.value?.trim();
                if (query && query.length >= CONFIG.MIN_QUERY_LENGTH) {
                    performSearch(query);
                }
            } else {
                showStatus('error', response?.error || 'Failed to delete');
            }

        } catch (error) {
            console.error('[Cyberbook] Delete error:', error);
            showStatus('error', 'Failed to delete bookmark');
        }
    }

    function createBookmarkItemElement(bookmark, showScore = false) {
        const item = document.createElement('div');
        item.className = 'bookmark-item';
        item.dataset.id = bookmark.id || '';
        item.dataset.url = bookmark.url || '';

        const content = document.createElement('div');
        content.className = 'bookmark-content';

        const title = document.createElement('div');
        title.className = 'bookmark-title';
        title.textContent = bookmark.title || 'Untitled';
        content.appendChild(title);

        const excerpt = document.createElement('div');
        excerpt.className = 'bookmark-excerpt';
        excerpt.textContent = truncate(bookmark.excerpt || '', 80);
        content.appendChild(excerpt);

        const meta = document.createElement('div');
        meta.className = 'bookmark-meta';

        const site = document.createElement('span');
        site.className = 'bookmark-site';
        site.textContent = bookmark.siteName || getDomain(bookmark.url);
        meta.appendChild(site);

        const time = document.createElement('span');
        time.className = 'bookmark-time';
        time.textContent = formatTimeAgo(bookmark.extractedAt);
        meta.appendChild(time);

        if (showScore && bookmark.score) {
            const score = document.createElement('span');
            score.className = 'bookmark-score';
            score.textContent = `${Math.round(bookmark.score * 100)}%`;
            meta.appendChild(score);
        }

        content.appendChild(meta);
        item.appendChild(content);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'bookmark-delete';
        deleteBtn.dataset.id = bookmark.id || '';
        deleteBtn.title = 'Delete bookmark';

        const deleteSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        deleteSvg.setAttribute('width', '14');
        deleteSvg.setAttribute('height', '14');
        deleteSvg.setAttribute('viewBox', '0 0 24 24');
        deleteSvg.setAttribute('fill', 'none');
        deleteSvg.setAttribute('stroke', 'currentColor');
        deleteSvg.setAttribute('stroke-width', '2');

        const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        polyline.setAttribute('points', '3 6 5 6 21 6');
        deleteSvg.appendChild(polyline);

        const deletePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        deletePath.setAttribute('d', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2');
        deleteSvg.appendChild(deletePath);

        deleteBtn.appendChild(deleteSvg);
        item.appendChild(deleteBtn);

        item.addEventListener('click', (e) => {
            if (!e.target.closest('.bookmark-delete')) {
                handleBookmarkClick(bookmark.url);
            }
        });

        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            handleDeleteBookmark(bookmark.id);
        });

        return item;
    }

    function showStatus(type, message) {
        if (!elements.bookmarkStatus) return;

        elements.bookmarkStatus.className = `bookmark-status ${type}`;
        elements.bookmarkStatus.textContent = message;
        elements.bookmarkStatus.classList.add('visible');

        setTimeout(() => {
            elements.bookmarkStatus.classList.remove('visible');
        }, CONFIG.STATUS_TIMEOUT_MS);
    }

    function sendMessage(message) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('[Cyberbook] Message error:', chrome.runtime.lastError);
                    resolve({ success: false, error: chrome.runtime.lastError.message });
                } else {
                    resolve(response);
                }
            });
        });
    }

    function truncate(str, length) {
        if (typeof str !== 'string') return '';
        if (str.length <= length) return str;
        return str.substring(0, length).trim() + '...';
    }

    function getDomain(url) {
        try {
            return new URL(url).hostname;
        } catch {
            return '';
        }
    }

    function formatTimeAgo(timestamp) {
        if (!timestamp) return '';

        const now = Date.now();
        const diff = now - timestamp;

        const minute = 60 * 1000;
        const hour = 60 * minute;
        const day = 24 * hour;
        const week = 7 * day;

        if (diff < minute) return 'just now';
        if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
        if (diff < day) return `${Math.floor(diff / hour)}h ago`;
        if (diff < week) return `${Math.floor(diff / day)}d ago`;

        return new Date(timestamp).toLocaleDateString();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }

})(typeof window !== 'undefined' ? window : this);
