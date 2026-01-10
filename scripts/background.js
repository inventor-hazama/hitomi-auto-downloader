// Background Service Worker
// v2.4.0 - ファイル名とタブタイトルで照合

// ============================================
// State Management
// ============================================

let downloadState = new Map();  // tabId -> state
let monitoredTabs = new Set();
let progressPollingInterval = null;

// 未紐付けダウンロードを追跡（後でファイル名が判明したときに照合）
let unmatchedDownloads = new Map();  // downloadId -> downloadItem info

async function saveStateToStorage() {
    const stateObject = {};
    for (const [tabId, state] of downloadState) {
        stateObject[tabId] = state;
    }
    await chrome.storage.local.set({ downloadState: stateObject });
}

async function loadStateFromStorage() {
    try {
        const result = await chrome.storage.local.get('downloadState');
        if (result.downloadState) {
            downloadState = new Map(Object.entries(result.downloadState).map(
                ([k, v]) => [parseInt(k), v]
            ));
            console.log('[Background] Restored state:', downloadState.size, 'tabs');
        }
    } catch (error) {
        console.error('[Background] Failed to load state:', error);
    }
}

loadStateFromStorage();

// ギャラリーIDを抽出
function extractGalleryId(url) {
    if (!url) return null;
    const match = url.match(/-(\d+)\.html/);
    return match ? match[1] : null;
}

// 文字列の類似度を計算（簡易版）
function getMatchScore(str1, str2) {
    if (!str1 || !str2) return 0;

    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();

    // 完全一致
    if (s1 === s2) return 100;

    // 含有チェック
    if (s1.includes(s2) || s2.includes(s1)) return 80;

    // 数字部分（ギャラリーID）の一致
    const nums1 = s1.match(/\d{5,}/g) || [];
    const nums2 = s2.match(/\d{5,}/g) || [];

    for (const n1 of nums1) {
        if (nums2.includes(n1)) return 90;
    }

    // 単語の重なり
    const words1 = s1.split(/[\s\-_\[\]()]+/).filter(w => w.length > 2);
    const words2 = s2.split(/[\s\-_\[\]()]+/).filter(w => w.length > 2);

    let matchCount = 0;
    for (const w1 of words1) {
        if (words2.some(w2 => w1.includes(w2) || w2.includes(w1))) {
            matchCount++;
        }
    }

    if (words1.length > 0) {
        return Math.round((matchCount / words1.length) * 70);
    }

    return 0;
}

// ダウンロードとタブをマッチング
async function matchDownloadToTab(downloadId, filename, url) {
    console.log(`[Background] Trying to match download ${downloadId}: "${filename}"`);

    let bestMatch = null;
    let bestScore = 0;

    for (const [tabId, state] of downloadState) {
        if (state.status !== 'in-progress') continue;
        if (state.downloadId) continue;  // 既に紐付け済み

        // スコア計算
        let score = 0;

        // ファイル名とタブタイトルを比較
        if (filename && state.title) {
            score = Math.max(score, getMatchScore(filename, state.title));
        }

        // ギャラリーIDで比較
        if (state.galleryId) {
            if (filename && filename.includes(state.galleryId)) {
                score = Math.max(score, 95);
            }
            if (url && url.includes(state.galleryId)) {
                score = Math.max(score, 95);
            }
        }

        console.log(`[Background]   Tab ${tabId} (${state.title?.substring(0, 30)}): score=${score}`);

        if (score > bestScore) {
            bestScore = score;
            bestMatch = tabId;
        }
    }

    if (bestMatch !== null && bestScore >= 50) {
        const state = downloadState.get(bestMatch);
        state.downloadId = downloadId;
        downloadState.set(bestMatch, state);
        await saveStateToStorage();
        console.log(`[Background] ✓ Matched download ${downloadId} -> tab ${bestMatch} (score: ${bestScore})`);
        return true;
    }

    console.log(`[Background] ✗ No match found for download ${downloadId} (best score: ${bestScore})`);
    return false;
}

// ============================================
// Progress Polling
// ============================================

async function pollTabProgress(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: getProgressFromPage
        });

        if (results && results[0] && results[0].result) {
            const { status, progress } = results[0].result;
            const currentState = downloadState.get(tabId);

            if (!currentState) return;

            currentState.progress = progress;

            if (status === 'downloading') {
                updateTabState(tabId, 'in-progress', `${progress}%`);
                currentState.hadProgressBar = true;
            } else if (status === 'preparing') {
                if (currentState.hadProgressBar && !currentState.downloadId) {
                    updateTabState(tabId, 'in-progress', 'ZIP準備中...');
                }
            }
        }
    } catch (error) {
        try { await chrome.tabs.get(tabId); } catch (e) { monitoredTabs.delete(tabId); }
    }
}

function getProgressFromPage() {
    const progressbar = document.getElementById('progressbar');
    const dlButton = document.getElementById('dl-button');

    if (progressbar) {
        const display = window.getComputedStyle(progressbar).display;
        if (display !== 'none') {
            const value = progressbar.getAttribute('aria-valuenow');
            return { status: 'downloading', progress: parseInt(value || '0', 10) };
        }
    }

    if (dlButton && window.getComputedStyle(dlButton).display !== 'none') {
        return { status: 'ready', progress: 0 };
    }

    return { status: 'preparing', progress: 100 };
}

function startProgressPolling() {
    if (progressPollingInterval) return;
    progressPollingInterval = setInterval(async () => {
        if (monitoredTabs.size === 0) {
            clearInterval(progressPollingInterval);
            progressPollingInterval = null;
            return;
        }
        for (const tabId of monitoredTabs) {
            await pollTabProgress(tabId);
        }
    }, 2000);
}

function addToMonitoring(tabId) {
    monitoredTabs.add(tabId);
    startProgressPolling();
}

// ============================================
// Chrome Downloads API
// ============================================

chrome.downloads.onCreated.addListener(async (downloadItem) => {
    console.log('[Background] Download created:', {
        id: downloadItem.id,
        filename: downloadItem.filename,
        url: downloadItem.url?.substring(0, 60)
    });

    // ファイル名がすぐに利用可能ならマッチング試行
    if (downloadItem.filename) {
        const matched = await matchDownloadToTab(downloadItem.id, downloadItem.filename, downloadItem.url);
        if (!matched) {
            unmatchedDownloads.set(downloadItem.id, {
                filename: downloadItem.filename,
                url: downloadItem.url
            });
        }
    } else {
        // ファイル名が後で判明するのを待つ
        unmatchedDownloads.set(downloadItem.id, {
            filename: null,
            url: downloadItem.url
        });
    }
});

chrome.downloads.onChanged.addListener(async (delta) => {
    // ファイル名が確定したとき
    if (delta.filename && delta.filename.current) {
        const info = unmatchedDownloads.get(delta.id);
        if (info) {
            console.log(`[Background] Filename determined for ${delta.id}: ${delta.filename.current}`);
            const matched = await matchDownloadToTab(delta.id, delta.filename.current, info.url);
            if (matched) {
                unmatchedDownloads.delete(delta.id);
            } else {
                info.filename = delta.filename.current;
            }
        }
    }

    // 状態変化
    if (delta.state) {
        for (const [tabId, state] of downloadState) {
            if (state.downloadId === delta.id) {
                if (delta.state.current === 'complete') {
                    console.log(`[Background] ✓ COMPLETE: download ${delta.id} -> tab ${tabId} "${state.title?.substring(0, 40)}"`);
                    updateTabState(tabId, 'complete', '');
                    monitoredTabs.delete(tabId);
                    unmatchedDownloads.delete(delta.id);
                    await saveStateToStorage();
                } else if (delta.state.current === 'interrupted') {
                    console.log(`[Background] ✗ INTERRUPTED: download ${delta.id} -> tab ${tabId}`);
                    updateTabState(tabId, 'error', delta.error?.current || 'ダウンロード中断');
                    monitoredTabs.delete(tabId);
                    unmatchedDownloads.delete(delta.id);
                    await saveStateToStorage();
                }
                return;
            }
        }

        // 紐付けされていないダウンロードが完了した場合、再度マッチング試行
        if (delta.state.current === 'complete') {
            const info = unmatchedDownloads.get(delta.id);
            if (info && info.filename) {
                console.log(`[Background] Unmatched download completed, trying to match: ${delta.id}`);
                const matched = await matchDownloadToTab(delta.id, info.filename, info.url);
                if (matched) {
                    const state = [...downloadState.values()].find(s => s.downloadId === delta.id);
                    if (state) {
                        const tabId = [...downloadState.entries()].find(([_, s]) => s === state)?.[0];
                        if (tabId) {
                            updateTabState(tabId, 'complete', '');
                            monitoredTabs.delete(tabId);
                        }
                    }
                }
                unmatchedDownloads.delete(delta.id);
            }
        }
    }
});

// ============================================
// Message Handler
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case 'START_DOWNLOADS':
            handleStartDownloads(message.tabIds, message.delay)
                .then(() => sendResponse({ success: true }))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;

        case 'GET_STATUS':
            const downloads = {};
            for (const [tabId, state] of downloadState) {
                downloads[tabId] = state;
            }
            sendResponse({ downloads });
            return false;

        case 'DOWNLOAD_CLICKED':
            if (sender.tab) {
                const state = downloadState.get(sender.tab.id) || {};
                state.hadProgressBar = false;
                downloadState.set(sender.tab.id, state);
                updateTabState(sender.tab.id, 'in-progress', 'ボタンクリック完了');
                addToMonitoring(sender.tab.id);
            }
            sendResponse({ success: true });
            return false;

        case 'DOWNLOAD_PROGRESS':
            if (sender.tab) {
                const state = downloadState.get(sender.tab.id);
                if (state) {
                    state.progress = message.progress;
                    state.hadProgressBar = true;
                }
                updateTabState(sender.tab.id, 'in-progress', `${message.progress}%`);
            }
            sendResponse({ success: true });
            return false;

        case 'DOWNLOAD_ERROR':
            if (sender.tab) {
                updateTabState(sender.tab.id, 'error', message.error);
                monitoredTabs.delete(sender.tab.id);
            }
            sendResponse({ success: true });
            return false;

        case 'RETRY_DOWNLOADS':
            handleRetryDownloads(message.tabIds, message.delay)
                .then(() => sendResponse({ success: true }))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;

        case 'CLEAR_COMPLETED':
            for (const [tabId, state] of downloadState) {
                if (state.status === 'complete') {
                    downloadState.delete(tabId);
                }
            }
            saveStateToStorage();
            sendResponse({ success: true });
            return false;
    }
});

chrome.commands.onCommand.addListener(async (command) => {
    if (command === 'download-all') {
        await startDownloadsFromShortcut();
    }
});

// ============================================
// Download Handlers
// ============================================

async function startDownloadsFromShortcut() {
    const tabs = await chrome.tabs.query({ currentWindow: true, url: '*://hitomi.la/*' });
    const contentTabs = tabs.filter(tab =>
        tab.url && (tab.url.includes('/doujinshi/') || tab.url.includes('/manga/') ||
            tab.url.includes('/gamecg/') || tab.url.includes('/cg/') ||
            tab.url.includes('/anime/') || tab.url.includes('/imageset/'))
    );
    if (contentTabs.length > 0) {
        await handleStartDownloads(contentTabs.map(t => t.id), 1000);
    }
}

async function handleStartDownloads(tabIds, delay = 1000) {
    for (let i = 0; i < tabIds.length; i++) {
        const tabId = tabIds[i];
        try {
            const tab = await chrome.tabs.get(tabId);
            const galleryId = extractGalleryId(tab.url);

            downloadState.set(tabId, {
                status: 'in-progress',
                downloadId: null,
                details: '処理中...',
                progress: 0,
                url: tab.url,
                title: tab.title,
                galleryId: galleryId,
                hadProgressBar: false,
                startTime: Date.now()
            });

            broadcastStatusUpdate(tabId, 'in-progress', '処理中...');
            await saveStateToStorage();

            console.log(`[Background] Starting: ${tabId} "${tab.title?.substring(0, 50)}" (id: ${galleryId})`);

            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: clickDownloadButton
            });

            addToMonitoring(tabId);

            if (i < tabIds.length - 1) await sleep(delay);
        } catch (error) {
            console.error(`Error processing tab ${tabId}:`, error);
            updateTabState(tabId, 'error', error.message);
        }
    }
}

async function handleRetryDownloads(tabIds, delay = 2000) {
    for (let i = 0; i < tabIds.length; i++) {
        const tabId = tabIds[i];
        try {
            await chrome.tabs.reload(tabId);
            await sleep(3000);

            const tab = await chrome.tabs.get(tabId);
            const galleryId = extractGalleryId(tab.url);

            downloadState.set(tabId, {
                status: 'in-progress',
                downloadId: null,
                details: 'ダウンロード開始...',
                progress: 0,
                url: tab.url,
                title: tab.title,
                galleryId: galleryId,
                hadProgressBar: false,
                startTime: Date.now()
            });

            broadcastStatusUpdate(tabId, 'in-progress', 'ダウンロード開始...');
            await saveStateToStorage();

            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: clickDownloadButton
            });

            addToMonitoring(tabId);

            if (i < tabIds.length - 1) await sleep(delay);
        } catch (error) {
            updateTabState(tabId, 'error', error.message);
        }
    }
}

// ============================================
// Utility
// ============================================

function updateTabState(tabId, status, details) {
    const state = downloadState.get(tabId) || { downloadId: null, progress: 0 };
    state.status = status;
    state.details = details;
    downloadState.set(tabId, state);
    broadcastStatusUpdate(tabId, status, details);
    if (status === 'complete' || status === 'error') saveStateToStorage();
}

function broadcastStatusUpdate(tabId, status, details) {
    chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', tabId, status, details }).catch(() => { });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function clickDownloadButton() {
    const dlButton = document.getElementById('dl-button');
    if (dlButton) {
        const rect = dlButton.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && window.getComputedStyle(dlButton).display !== 'none') {
            dlButton.click();
            return { success: true };
        }
    }
    const downloadH1 = document.querySelector('a h1');
    if (downloadH1 && downloadH1.textContent.trim() === 'Download') {
        downloadH1.closest('a')?.click();
        return { success: true };
    }
    return { success: false, error: 'Download button not found' };
}
