// offscreen.js - ML Pipeline for Cyberbook
// FIXES: Lazy model loading, queue management, timeout handling

import { pipeline, env } from '@huggingface/transformers';

const MODEL_CONFIG = Object.freeze({
    MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
    QUANTIZED: true,
    EMBEDDING_DIM: 384,
    MAX_TOKENS: 512,
    MAX_TEXT_LENGTH: 10000,
    LOAD_TIMEOUT_MS: 60000,
    QUEUE_MAX_SIZE: 50
});

const ALLOWED_MESSAGE_TYPES = Object.freeze([
    'WARMUP_MODEL',
    'GENERATE_EMBEDDING',
    'COMPRESS',
    'DECOMPRESS',
    'PING'
]);

let embeddingPipeline = null;
let modelLoadingPromise = null;
let modelReady = false;

const embeddingQueue = [];
let isProcessingQueue = false;

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;

async function getEmbeddingPipeline() {
    if (embeddingPipeline) {
        return embeddingPipeline;
    }

    if (modelLoadingPromise) {
        return modelLoadingPromise;
    }

    console.log('[Offscreen] Loading embedding model...');
    const startTime = performance.now();

    const loadPromise = pipeline(
        'feature-extraction',
        MODEL_CONFIG.MODEL_ID,
        {
            dtype: MODEL_CONFIG.QUANTIZED ? 'q8' : 'fp32',
            progress_callback: (progress) => {
                if (progress.status === 'downloading') {
                    console.log(`[Offscreen] Downloading: ${progress.file} (${Math.round(progress.progress)}%)`);
                }
            }
        }
    );

    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
            reject(new Error(`Model loading timed out after ${MODEL_CONFIG.LOAD_TIMEOUT_MS}ms`));
        }, MODEL_CONFIG.LOAD_TIMEOUT_MS);
    });

    modelLoadingPromise = Promise.race([loadPromise, timeoutPromise]);

    try {
        embeddingPipeline = await modelLoadingPromise;
        modelReady = true;

        const loadTime = Math.round(performance.now() - startTime);
        console.log(`[Offscreen] Model loaded in ${loadTime}ms`);

        return embeddingPipeline;

    } catch (error) {
        console.error('[Offscreen] Failed to load model:', error);
        modelLoadingPromise = null;
        throw error;
    }
}

async function warmupModel() {
    const startTime = performance.now();

    try {
        console.log('[Offscreen] Warmup requested - model will load on first use');
        
        const warmupTime = Math.round(performance.now() - startTime);

        return {
            success: true,
            loadTimeMs: warmupTime,
            modelId: MODEL_CONFIG.MODEL_ID,
            embeddingDim: MODEL_CONFIG.EMBEDDING_DIM,
            lazy: true
        };

    } catch (error) {
        console.error('[Offscreen] Model warmup failed:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

async function generateEmbedding(text) {
    if (typeof text !== 'string' || text.trim().length === 0) {
        throw new Error('Text must be a non-empty string');
    }

    let processedText = text;
    if (text.length > MODEL_CONFIG.MAX_TEXT_LENGTH) {
        processedText = text.substring(0, MODEL_CONFIG.MAX_TEXT_LENGTH);
        console.log(`[Offscreen] Text truncated from ${text.length} to ${MODEL_CONFIG.MAX_TEXT_LENGTH} chars`);
    }

    const pipe = await getEmbeddingPipeline();

    const output = await pipe(processedText, {
        pooling: 'mean',
        normalize: true
    });

    try {
        const embedding = new Float32Array(output.data);

        if (embedding.length !== MODEL_CONFIG.EMBEDDING_DIM) {
            throw new Error(`Unexpected embedding dimension: ${embedding.length}, expected ${MODEL_CONFIG.EMBEDDING_DIM}`);
        }

        for (let i = 0; i < embedding.length; i++) {
            if (!Number.isFinite(embedding[i])) {
                throw new Error('Embedding contains invalid values (NaN or Infinity)');
            }
        }

        return embedding;

    } finally {
        if (output && typeof output.dispose === 'function') {
            output.dispose();
        }
    }
}

async function processEmbeddingQueue() {
    if (isProcessingQueue || embeddingQueue.length === 0) {
        return;
    }

    isProcessingQueue = true;

    while (embeddingQueue.length > 0) {
        const { text, resolve, reject } = embeddingQueue.shift();

        try {
            const embedding = await generateEmbedding(text);
            resolve(embedding);
        } catch (error) {
            reject(error);
        }
    }

    isProcessingQueue = false;
}

function queueEmbedding(text) {
    return new Promise((resolve, reject) => {
        if (embeddingQueue.length >= MODEL_CONFIG.QUEUE_MAX_SIZE) {
            reject(new Error('Embedding queue is full'));
            return;
        }

        embeddingQueue.push({ text, resolve, reject });
        processEmbeddingQueue();
    });
}

async function compressText(text) {
    if (typeof text !== 'string') {
        throw new Error('Text must be a string');
    }

    const encoder = new TextEncoder();
    const data = encoder.encode(text);

    const compressedStream = new Blob([data]).stream().pipeThrough(
        new CompressionStream('gzip')
    );

    return new Response(compressedStream).blob();
}

async function decompressText(blob) {
    if (!(blob instanceof Blob)) {
        throw new Error('Input must be a Blob');
    }

    const decompressedStream = blob.stream().pipeThrough(
        new DecompressionStream('gzip')
    );

    const text = await new Response(decompressedStream).text();
    return text;
}

async function blobToBase64(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToBlob(base64, mimeType = 'application/octet-stream') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
}

function validateMessage(message) {
    if (!message || typeof message !== 'object') {
        return false;
    }
    if (typeof message.type !== 'string') {
        return false;
    }
    if (!ALLOWED_MESSAGE_TYPES.includes(message.type)) {
        return false;
    }
    return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!sender || sender.id !== chrome.runtime.id) {
        console.warn('[Offscreen] Rejected message from unknown sender:', sender?.id);
        return false;
    }

    if (message.target !== 'offscreen') {
        return false;
    }

    if (!validateMessage(message)) {
        sendResponse({ success: false, error: 'Invalid message format' });
        return true;
    }

    handleMessage(message)
        .then(sendResponse)
        .catch(error => {
            console.error('[Offscreen] Handler error:', error);
            sendResponse({ success: false, error: error.message });
        });

    return true;
});

async function handleMessage(message) {
    switch (message.type) {
        case 'WARMUP_MODEL':
            return warmupModel();

        case 'GENERATE_EMBEDDING':
            return handleGenerateEmbedding(message);

        case 'COMPRESS':
            return handleCompress(message);

        case 'DECOMPRESS':
            return handleDecompress(message);

        case 'PING':
            return {
                success: true,
                status: 'ok',
                modelReady: modelReady,
                queueLength: embeddingQueue.length,
                timestamp: Date.now()
            };

        default:
            return { success: false, error: 'Unknown message type' };
    }
}

async function handleGenerateEmbedding(message) {
    if (typeof message.text !== 'string') {
        return { success: false, error: 'Missing or invalid text field' };
    }

    let text = message.text.trim();

    if (!text || text.length === 0) {
        return { success: false, error: 'Text is empty' };
    }

    try {
        const embedding = await queueEmbedding(text);

        return {
            success: true,
            embedding: Array.from(embedding),
            dimension: embedding.length
        };

    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function handleCompress(message) {
    if (typeof message.text !== 'string') {
        return { success: false, error: 'Missing or invalid text field' };
    }

    try {
        const compressedBlob = await compressText(message.text);
        const base64 = await blobToBase64(compressedBlob);

        return {
            success: true,
            compressedBase64: base64,
            originalSize: message.text.length,
            compressedSize: compressedBlob.size
        };

    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function handleDecompress(message) {
    if (typeof message.compressedBase64 !== 'string') {
        return { success: false, error: 'Missing or invalid compressedBase64 field' };
    }

    try {
        const blob = base64ToBlob(message.compressedBase64, 'application/gzip');
        const text = await decompressText(blob);

        return {
            success: true,
            text: text
        };

    } catch (error) {
        return { success: false, error: error.message };
    }
}

console.log('[Offscreen] Document initialized');
console.log('[Offscreen] Model:', MODEL_CONFIG.MODEL_ID);
console.log('[Offscreen] Embedding dimension:', MODEL_CONFIG.EMBEDDING_DIM);
