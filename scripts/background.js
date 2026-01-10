// Background Service Worker
// v2.3.0 - referrerを使った正確なタブ紐付け

// ============================================
// State Management
// ============================================

let downloadState = new Map();  // tabId -> { status, downloadId, details, progress, url, title, galleryId }
let monitoredTabs = new Set();
let progressPollingInterval = null;

// ストレージに保存
async function saveStateToStorage() {
    const stateObject = {};
    for (const [tabId, state] of downloadState) {
        stateObject[tabId] = state;
    }
    await chrome.storage.local.set({ downloadState: stateObject });
}

// ストレージから復元
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

// URLからギャラリーIDを抽出
function extractGalleryId(url) {
    if (!url) return null;
    const match = url.match(/-(\d+)\.html/);
    return match ? match[1] : null;
}

// URL正規化（比較用）
function normalizeUrl(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        // ハッシュとクエリを除去してパスのみで比較
        return u.origin + u.pathname;
    } catch (e) {
        return url;
    }
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
            const { status, progress, hasProgressBar, progressBarVisible } = results[0].result;
            const currentState = downloadState.get(tabId);

            if (!currentState) return;

            currentState.progress = progress;

            if (status === 'downloading' && hasProgressBar && progressBarVisible) {
                updateTabState(tabId, 'in-progress', `${progress}%`);
                currentState.hadProgressBar = true;
            } else if (status === 'preparing') {
                if (currentState.hadProgressBar && !currentState.downloadId) {
                    updateTabState(tabId, 'in-progress', 'ZIP準備中...');
                }
            }
        }
    } catch (error) {
        try {
            await chrome.tabs.get(tabId);
        } catch (e) {
            monitoredTabs.delete(tabId);
        }
    }
}

function getProgressFromPage() {
    const progressbar = document.getElementById('progressbar');
    const dlButton = document.getElementById('dl-button');

    let hasProgressBar = false;
    let progressBarVisible = false;
    let progress = 0;

    if (progressbar) {
        hasProgressBar = true;
        const display = window.getComputedStyle(progressbar).display;
        progressBarVisible = display !== 'none';
        const value = progressbar.getAttribute('aria-valuenow');
        progress = parseInt(value || '0', 10);
    }

    const dlButtonVisible = dlButton && window.getComputedStyle(dlButton).display !== 'none';

    if (progressBarVisible && progress > 0) {
        return { status: 'downloading', progress, hasProgressBar, progressBarVisible };
    } else if (hasProgressBar && !progressBarVisible && !dlButtonVisible) {
        return { status: 'preparing', progress: 100, hasProgressBar, progressBarVisible };
    } else if (dlButtonVisible) {
        return { status: 'ready', progress: 0, hasProgressBar, progressBarVisible };
    }

    return { status: 'unknown', progress, hasProgressBar, progressBarVisible };
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
// Chrome Downloads API - referrerで正確な紐付け
// ============================================

chrome.downloads.onCreated.addListener(async (downloadItem) => {
    console.log('[Background] Download created:', {
        id: downloadItem.id,
        url: downloadItem.url?.substring(0, 80),
        referrer: downloadItem.referrer,
        filename: downloadItem.filename,
        finalUrl: downloadItem.finalUrl
    });

    const referrer = downloadItem.referrer;
    const normalizedReferrer = normalizeUrl(referrer);

    // 方法1: referrer URLでタブを照合
    if (referrer && referrer.includes('hitomi.la')) {
        for (const [tabId, state] of downloadState) {
            if (state.status === 'in-progress' && !state.downloadId) {
                const normalizedTabUrl = normalizeUrl(state.url);

                if (normalizedTabUrl === normalizedReferrer) {
                    state.downloadId = downloadItem.id;
                    downloadState.set(tabId, state);
                    await saveStateToStorage();
                    console.log(`[Background] ✓ Matched by referrer: download ${downloadItem.id} -> tab ${tabId}`);
                    console.log(`[Background]   referrer: ${referrer}`);
                    console.log(`[Background]   tabUrl: ${state.url}`);
                    return;
                }
            }
        }

        // ギャラリーIDで照合
        const referrerGalleryId = extractGalleryId(referrer);
        if (referrerGalleryId) {
            for (const [tabId, state] of downloadState) {
                if (state.status === 'in-progress' && !state.downloadId && state.galleryId === referrerGalleryId) {
                    state.downloadId = downloadItem.id;
                    downloadState.set(tabId, state);
                    await saveStateToStorage();
                    console.log(`[Background] ✓ Matched by galleryId: download ${downloadItem.id} -> tab ${tabId} (galleryId: ${referrerGalleryId})`);
                    return;
                }
            }
        }
    }

    // 方法2: ダウンロードURLやファイル名からギャラリーID抽出
    let downloadGalleryId = null;
    if (downloadItem.url) {
        const urlMatch = downloadItem.url.match(/(\d{6,})/);
        if (urlMatch) downloadGalleryId = urlMatch[1];
    }
    if (!downloadGalleryId && downloadItem.filename) {
        const fnMatch = downloadItem.filename.match(/(\d{6,})/);
        if (fnMatch) downloadGalleryId = fnMatch[1];
    }

    if (downloadGalleryId) {
        for (const [tabId, state] of downloadState) {
            if (state.status === 'in-progress' && !state.downloadId && state.galleryId === downloadGalleryId) {
                state.downloadId = downloadItem.id;
                downloadState.set(tabId, state);
                await saveStateToStorage();
                console.log(`[Background] ✓ Matched by download galleryId: download ${downloadItem.id} -> tab ${tabId} (galleryId: ${downloadGalleryId})`);
                return;
            }
        }
    }

    // フォールバック: 最も古い未紐付けタブに割り当て
    let oldestTab = null;
    let oldestTime = Infinity;

    for (const [tabId, state] of downloadState) {
        if (state.status === 'in-progress' && !state.downloadId) {
            if (state.startTime && state.startTime < oldestTime) {
                oldestTime = state.startTime;
                oldestTab = tabId;
            }
        }
    }

    if (oldestTab !== null) {
        const state = downloadState.get(oldestTab);
        state.downloadId = downloadItem.id;
        downloadState.set(oldestTab, state);
        await saveStateToStorage();
        console.log(`[Background] ⚠ Fallback: download ${downloadItem.id} -> oldest tab ${oldestTab}`);
    } else {
        console.log(`[Background] ✗ No matching tab found for download ${downloadItem.id}`);
    }
});

chrome.downloads.onChanged.addListener(async (delta) => {
    if (!delta.state) return;

    for (const [tabId, state] of downloadState) {
        if (state.downloadId === delta.id) {
            if (delta.state.current === 'complete') {
                console.log(`[Background] ✓ Download complete: ${delta.id} -> tab ${tabId} (${state.title})`);
                updateTabState(tabId, 'complete', '');
                monitoredTabs.delete(tabId);
                await saveStateToStorage();
            } else if (delta.state.current === 'interrupted') {
                console.log(`[Background] ✗ Download interrupted: ${delta.id} -> tab ${tabId}`);
                updateTabState(tabId, 'error', delta.error?.current || 'ダウンロード中断');
                monitoredTabs.delete(tabId);
                await saveStateToStorage();
            }
            break;
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
                broadcastProgressUpdate(sender.tab.id, message.progress);
            }
            sendResponse({ success: true });
            return false;

        case 'DOWNLOAD_COMPLETE':
            console.log('[Background] Ignoring DOWNLOAD_COMPLETE from content script');
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

// ============================================
// Keyboard Shortcut
// ============================================

chrome.commands.onCommand.addListener(async (command) => {
    if (command === 'download-all') {
        await startDownloadsFromShortcut();
    }
});

// ============================================
// Download Handlers
// ============================================

async function startDownloadsFromShortcut() {
    try {
        const tabs = await chrome.tabs.query({
            currentWindow: true,
            url: '*://hitomi.la/*'
        });

        const contentTabs = tabs.filter(tab =>
            tab.url &&
            (tab.url.includes('/doujinshi/') ||
                tab.url.includes('/manga/') ||
                tab.url.includes('/gamecg/') ||
                tab.url.includes('/cg/') ||
                tab.url.includes('/anime/') ||
                tab.url.includes('/imageset/'))
        );

        if (contentTabs.length === 0) return;
        await handleStartDownloads(contentTabs.map(t => t.id), 1000);
    } catch (error) {
        console.error('Error starting downloads from shortcut:', error);
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

            console.log(`[Background] Starting tab ${tabId}: ${tab.title?.substring(0, 40)} (galleryId: ${galleryId})`);

            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: clickDownloadButton
            });

            addToMonitoring(tabId);

            if (i < tabIds.length - 1) {
                await sleep(delay);
            }
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
                details: 'リロード完了...',
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

            if (i < tabIds.length - 1) {
                await sleep(delay);
            }
        } catch (error) {
            console.error(`Error retrying tab ${tabId}:`, error);
            updateTabState(tabId, 'error', error.message);
        }
    }
}

// ============================================
// Utility Functions
// ============================================

function updateTabState(tabId, status, details) {
    const state = downloadState.get(tabId) || { downloadId: null, progress: 0 };
    state.status = status;
    state.details = details;
    downloadState.set(tabId, state);
    broadcastStatusUpdate(tabId, status, details);

    if (status === 'complete' || status === 'error') {
        saveStateToStorage();
    }
}

function broadcastStatusUpdate(tabId, status, details) {
    chrome.runtime.sendMessage({
        type: 'STATUS_UPDATE',
        tabId: tabId,
        status: status,
        details: details
    }).catch(() => { });
}

function broadcastProgressUpdate(tabId, progress) {
    chrome.runtime.sendMessage({
        type: 'DOWNLOAD_PROGRESS',
        tabId: tabId,
        progress: progress
    }).catch(() => { });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// Injected Function
// ============================================

function clickDownloadButton() {
    console.log('[Hitomi Downloader] clickDownloadButton called');

    const dlButton = document.getElementById('dl-button');
    if (dlButton) {
        const rect = dlButton.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0;
        const displayStyle = window.getComputedStyle(dlButton).display;

        if (isVisible && displayStyle !== 'none') {
            console.log('[Hitomi Downloader] Found #dl-button, clicking...');
            dlButton.click();
            return { success: true, method: 'id', element: '#dl-button' };
        } else {
            const progressbar = document.getElementById('progressbar');
            if (progressbar) {
                const progress = progressbar.getAttribute('aria-valuenow') || '0';
                return {
                    success: false,
                    error: 'Download already in progress',
                    progress: parseInt(progress, 10)
                };
            }
        }
    }

    const downloadH1 = document.querySelector('a h1');
    if (downloadH1 && downloadH1.textContent.trim() === 'Download') {
        const parentLink = downloadH1.closest('a');
        if (parentLink) {
            parentLink.click();
            return { success: true, method: 'h1', element: 'a > h1' };
        }
    }

    const allLinks = document.querySelectorAll('a, button');
    for (const element of allLinks) {
        const text = element.textContent.trim();
        if (text === 'Download' || text === 'ダウンロード') {
            const rect = element.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                element.click();
                return { success: true, method: 'text', element: element.tagName };
            }
        }
    }

    return { success: false, error: 'Download button not found' };
}
