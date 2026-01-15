// offscreen.js - ML inference for Cyberbook
// FIXES APPLIED:
// - Lazy model loading (not on warmup)
// - Queue management for embedding generation
// - Timeout handling for model loading
// - Persistent model promise (no reset on success)

import { pipeline } from '@xenova/transformers';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const MODEL_TIMEOUT_MS = 120000; // 2 minutes for initial download
const EMBEDDING_TIMEOUT_MS = 30000; // 30 seconds per embedding

// State - model promise persists after successful load
let modelPromise = null;
let embeddingQueue = [];
let isProcessingQueue = false;

/**
 * Load the embedding model with timeout
 * Promise is cached - model only loads once
 */
async function getModel() {
    if (modelPromise) {
        return modelPromise;
    }

    console.log('[Cyberbook Offscreen] Loading model...');
    const startTime = performance.now();

    modelPromise = Promise.race([
        pipeline('feature-extraction', MODEL_ID, {
            quantized: true
        }),
        new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Model load timeout')), MODEL_TIMEOUT_MS)
        )
    ]).then(model => {
        const elapsed = Math.round(performance.now() - startTime);
        console.log(`[Cyberbook Offscreen] Model loaded in ${elapsed}ms`);
        return model;
    }).catch(error => {
        // Reset promise on failure so retry is possible
        modelPromise = null;
        throw error;
    });

    return modelPromise;
}

/**
 * Generate embedding for text with timeout
 */
async function generateEmbedding(text) {
    if (!text || typeof text !== 'string') {
        throw new Error('Text is required');
    }

    const model = await getModel();
    
    // Truncate to reasonable length (model context limit)
    const truncated = text.substring(0, 8000);

    const result = await Promise.race([
        model(truncated, { pooling: 'mean', normalize: true }),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Embedding timeout')), EMBEDDING_TIMEOUT_MS)
        )
    ]);

    // Extract embedding array
    const embedding = Array.from(result.data);
    return embedding;
}

/**
 * Queue-based embedding generation to prevent overload
 */
function queueEmbedding(text, resolve, reject) {
    embeddingQueue.push({ text, resolve, reject });
    processQueue();
}

async function processQueue() {
    if (isProcessingQueue || embeddingQueue.length === 0) {
        return;
    }

    isProcessingQueue = true;

    while (embeddingQueue.length > 0) {
        const { text, resolve, reject } = embeddingQueue.shift();
        
        try {
            const embedding = await generateEmbedding(text);
            resolve({ success: true, embedding });
        } catch (error) {
            console.error('[Cyberbook Offscreen] Embedding error:', error);
            reject({ success: false, error: error.message });
        }
    }

    isProcessingQueue = false;
}

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'offscreen') {
        return false;
    }

    switch (message.type) {
        case 'GENERATE_EMBEDDING':
            // Use queue for backpressure management
            new Promise((resolve, reject) => {
                queueEmbedding(message.text, resolve, reject);
            }).then(sendResponse).catch(sendResponse);
            return true;

        case 'WARMUP_MODEL':
            // Lazy load - just trigger model load, don't wait
            getModel()
                .then(() => sendResponse({ success: true }))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;

        case 'GET_STATUS':
            sendResponse({
                modelLoaded: modelPromise !== null,
                queueLength: embeddingQueue.length,
                isProcessing: isProcessingQueue
            });
            return true;

        default:
            sendResponse({ error: 'Unknown message type' });
            return true;
    }
});

console.log('[Cyberbook Offscreen] Ready');
