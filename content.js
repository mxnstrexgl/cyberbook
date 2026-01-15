// content.js - Page content extraction for Cyberbook
// Uses Mozilla Readability for article extraction

(function() {
    'use strict';

    // Prevent multiple injections
    if (window.__cyberbookContentLoaded) return;
    window.__cyberbookContentLoaded = true;

    /**
     * Extract page content using Readability
     */
    function extractPageContent() {
        try {
            // Clone document for Readability (it modifies the DOM)
            const documentClone = document.cloneNode(true);

            // Try Readability first
            let article = null;
            if (typeof Readability !== 'undefined') {
                const reader = new Readability(documentClone);
                article = reader.parse();
            }

            if (article && article.textContent && article.textContent.length > 100) {
                return {
                    title: article.title || document.title,
                    textContent: article.textContent,
                    excerpt: article.excerpt || article.textContent.substring(0, 300),
                    siteName: article.siteName || extractSiteName(),
                    wordCount: countWords(article.textContent)
                };
            }

            // Fallback: extract from body
            const bodyText = document.body?.innerText || '';
            return {
                title: document.title,
                textContent: bodyText.substring(0, 50000), // Limit size
                excerpt: bodyText.substring(0, 300),
                siteName: extractSiteName(),
                wordCount: countWords(bodyText)
            };

        } catch (error) {
            console.error('[Cyberbook] Content extraction failed:', error);
            return {
                title: document.title,
                textContent: document.body?.innerText?.substring(0, 10000) || '',
                excerpt: '',
                siteName: extractSiteName(),
                wordCount: 0
            };
        }
    }

    function extractSiteName() {
        // Try meta tags first
        const ogSiteName = document.querySelector('meta[property="og:site_name"]');
        if (ogSiteName) return ogSiteName.content;

        const appName = document.querySelector('meta[name="application-name"]');
        if (appName) return appName.content;

        // Fall back to hostname
        return window.location.hostname.replace(/^www\./, '');
    }

    function countWords(text) {
        if (!text) return 0;
        return text.trim().split(/\s+/).filter(w => w.length > 0).length;
    }

    // Listen for save requests from popup
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'EXTRACT_CONTENT') {
            const content = extractPageContent();
            sendResponse({
                success: true,
                ...content,
                url: window.location.href
            });
            return true;
        }
    });

    console.log('[Cyberbook] Content script loaded');
})();
