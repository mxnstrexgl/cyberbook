// bookmark-content.js - Content script for page extraction

import { Readability } from '@mozilla/readability';

(function (global) {
    'use strict';

    const ALLOWED_ACTIONS = Object.freeze([
        'EXTRACT_CONTENT',
        'PING'
    ]);

    const LIMITS = Object.freeze({
        TITLE_MAX: 500,
        EXCERPT_MAX: 1000,
        TEXT_MAX: 100000,
        SITE_NAME_MAX: 100,
        WORD_COUNT_MAX: 1000000
    });

    function extractPageContent() {
        let documentClone = null;

        try {
            documentClone = document.cloneNode(true);

            const reader = new Readability(documentClone, {
                charThreshold: 100,
                classesToPreserve: [],
                keepClasses: false
            });

            const article = reader.parse();

            if (!article) {
                console.debug('[Cyberbook] Readability could not parse this page');
                return null;
            }

            const canonicalUrl = getCanonicalUrl();

            const rawContent = {
                title: article.title || document.title || '',
                excerpt: article.excerpt || getMetaDescription() || '',
                textContent: article.textContent || '',
                siteName: article.siteName || getSiteName(),
                url: canonicalUrl,
                wordCount: countWords(article.textContent),
                extractedAt: Date.now()
            };

            return sanitizeExtractedContent(rawContent);

        } catch (error) {
            console.debug('[Cyberbook] Extraction error', error.message);
            return null;

        } finally {
            documentClone = null;
        }
    }

    function sanitizeExtractedContent(rawContent) {
        const sanitized = Object.create(null);

        sanitized.title = sanitizeString(rawContent.title, LIMITS.TITLE_MAX) || 'Untitled';
        sanitized.excerpt = sanitizeString(rawContent.excerpt, LIMITS.EXCERPT_MAX) || '';
        sanitized.textContent = sanitizeString(rawContent.textContent, LIMITS.TEXT_MAX) || '';
        sanitized.siteName = sanitizeString(rawContent.siteName, LIMITS.SITE_NAME_MAX) || '';

        try {
            const url = new URL(rawContent.url);
            sanitized.url = (url.protocol === 'http:' || url.protocol === 'https:')
                ? url.href
                : '';
        } catch {
            sanitized.url = '';
        }

        sanitized.wordCount = Math.max(0, Math.min(LIMITS.WORD_COUNT_MAX, parseInt(rawContent.wordCount) || 0));
        sanitized.extractedAt = rawContent.extractedAt || Date.now();

        return sanitized;
    }

    function sanitizeString(str, maxLen) {
        if (typeof str !== 'string') return '';
        return str
            .replace(/<[^>]*>/g, '')
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
            .trim()
            .substring(0, maxLen);
    }

    function getCanonicalUrl() {
        const canonical = document.querySelector('link[rel="canonical"]');
        if (canonical && canonical.href) {
            return canonical.href;
        }

        const ogUrl = document.querySelector('meta[property="og:url"]');
        if (ogUrl && ogUrl.content) {
            return ogUrl.content;
        }

        return window.location.href;
    }

    function getSiteName() {
        const ogSite = document.querySelector('meta[property="og:site_name"]');
        if (ogSite && ogSite.content) {
            return ogSite.content;
        }

        const appName = document.querySelector('meta[name="application-name"]');
        if (appName && appName.content) {
            return appName.content;
        }

        return window.location.hostname;
    }

    function getMetaDescription() {
        const desc = document.querySelector('meta[name="description"]');
        if (desc && desc.content) {
            return desc.content;
        }

        const ogDesc = document.querySelector('meta[property="og:description"]');
        if (ogDesc && ogDesc.content) {
            return ogDesc.content;
        }

        return '';
    }

    function countWords(text) {
        if (typeof text !== 'string') return 0;
        const words = text.trim().split(/\s+/).filter(word => word.length > 0);
        return words.length;
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!sender || sender.id !== chrome.runtime.id) {
            return false;
        }

        if (!message || typeof message !== 'object') {
            sendResponse({ error: 'Invalid message format' });
            return true;
        }

        if (!ALLOWED_ACTIONS.includes(message.action)) {
            sendResponse({ error: 'Unknown action' });
            return true;
        }

        switch (message.action) {
            case 'EXTRACT_CONTENT':
                handleExtractContent(sendResponse);
                return true;

            case 'PING':
                sendResponse({ status: 'ok', timestamp: Date.now() });
                return true;

            default:
                sendResponse({ error: 'Unknown action' });
                return true;
        }
    });

    function handleExtractContent(sendResponse) {
        try {
            const content = extractPageContent();

            if (!content) {
                sendResponse({
                    success: false,
                    error: 'Could not extract content from this page'
                });
                return;
            }

            if (!content.url) {
                sendResponse({
                    success: false,
                    error: 'Invalid URL - cannot bookmark this page'
                });
                return;
            }

            sendResponse({
                success: true,
                data: content
            });

        } catch (error) {
            sendResponse({
                success: false,
                error: 'Extraction failed: ' + (error.message || 'Unknown error')
            });
        }
    }

    console.debug('[Cyberbook] Content script initialized', {
        url: window.location.href,
        timestamp: Date.now()
    });

})(typeof window !== 'undefined' ? window : this);
