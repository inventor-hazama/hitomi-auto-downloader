// Background Service Worker
// v2.1.0 - Chrome Downloads APIを使った正確な完了検出

// ============================================
// State Management with chrome.storage.local
// ============================================

// メモリ内キャッシュ
let downloadState = new Map();  // tabId -> { status, downloadId, details, progress, url, title }

// 監視中のタブ
let monitoredTabs = new Set();
let progressPollingInterval = null;

// 直近でダウンロードボタンをクリックしたタブを追跡（順番にダウンロードIDを割り当て）
let pendingDownloadTabs = [];

// ステータスをストレージに保存
async function saveStateToStorage() {
    const stateObject = {};
    for (const [tabId, state] of downloadState) {
        stateObject[tabId] = state;
    }
    await chrome.storage.local.set({ downloadState: stateObject });
}

// ストレージからステータスを復元
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

// 初期化
loadStateFromStorage();

// ============================================
// Progress Polling from Background
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

            // 現在の進捗を保存
            currentState.progress = progress;

            if (status === 'downloading' && hasProgressBar && progressBarVisible) {
                // プログレスバーが表示されてダウンロード中
                updateTabState(tabId, 'in-progress', `${progress}%`);
                currentState.hadProgressBar = true;  // プログレスバーを見たことを記録
            } else if (status === 'preparing') {
                // ZIP準備中（プログレスバーが消えたがダウンロードIDがまだない）
                if (currentState.hadProgressBar && !currentState.downloadId) {
                    updateTabState(tabId, 'in-progress', 'ZIP準備中...');
                }
            }
            // 注意: 完了判定はChrome Downloads APIに任せる
        }
    } catch (error) {
        console.log(`[Background] Tab ${tabId} polling error:`, error.message);
        // タブが閉じられた場合のみ監視を停止
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
        // プログレスバーが存在するが非表示、ダウンロードボタンも非表示 → ZIP準備中
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
// Chrome Downloads API - 正確な完了検出
// ============================================

// ダウンロード作成時: タブとの紐付け
chrome.downloads.onCreated.addListener(async (downloadItem) => {
    // ZIPファイルかどうかチェック
    const isZip = downloadItem.filename?.endsWith('.zip') ||
        downloadItem.mime === 'application/zip' ||
        downloadItem.url?.includes('.zip');

    console.log('[Background] Download created:', {
        id: downloadItem.id,
        url: downloadItem.url?.substring(0, 100),
        filename: downloadItem.filename,
        mime: downloadItem.mime,
        isZip
    });

    // 待機中のタブがあれば紐付け
    if (pendingDownloadTabs.length > 0) {
        const tabId = pendingDownloadTabs.shift();
        const state = downloadState.get(tabId);
        if (state && state.status === 'in-progress') {
            state.downloadId = downloadItem.id;
            downloadState.set(tabId, state);
            await saveStateToStorage();
            console.log(`[Background] Linked download ${downloadItem.id} to tab ${tabId}`);
        }
    } else {
        // hitomi.laタブでin-progressかつdownloadIdがないものを探す
        for (const [tabId, state] of downloadState) {
            if (state.status === 'in-progress' && !state.downloadId) {
                state.downloadId = downloadItem.id;
                downloadState.set(tabId, state);
                await saveStateToStorage();
                console.log(`[Background] Auto-linked download ${downloadItem.id} to tab ${tabId}`);
                break;
            }
        }
    }
});

// ダウンロード状態変化時: 完了/エラー検出
chrome.downloads.onChanged.addListener(async (delta) => {
    if (!delta.state) return;

    for (const [tabId, state] of downloadState) {
        if (state.downloadId === delta.id) {
            if (delta.state.current === 'complete') {
                console.log(`[Background] Download ${delta.id} complete for tab ${tabId}`);
                updateTabState(tabId, 'complete', '');
                monitoredTabs.delete(tabId);
                await saveStateToStorage();
            } else if (delta.state.current === 'interrupted') {
                console.log(`[Background] Download ${delta.id} interrupted for tab ${tabId}`);
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
                pendingDownloadTabs.push(sender.tab.id);
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
            // Content scriptからの完了通知は無視（Downloads APIで判定）
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
    // 既存の待機リストをクリア
    pendingDownloadTabs = [];

    for (let i = 0; i < tabIds.length; i++) {
        const tabId = tabIds[i];

        try {
            const tab = await chrome.tabs.get(tabId);

            downloadState.set(tabId, {
                status: 'in-progress',
                downloadId: null,
                details: '処理中...',
                progress: 0,
                url: tab.url,
                title: tab.title,
                hadProgressBar: false
            });
            broadcastStatusUpdate(tabId, 'in-progress', '処理中...');
            await saveStateToStorage();

            // 待機リストに追加
            pendingDownloadTabs.push(tabId);

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
    pendingDownloadTabs = [];

    for (let i = 0; i < tabIds.length; i++) {
        const tabId = tabIds[i];

        try {
            downloadState.set(tabId, {
                status: 'in-progress',
                downloadId: null,
                details: 'リロード中...',
                progress: 0,
                hadProgressBar: false
            });
            broadcastStatusUpdate(tabId, 'in-progress', 'リロード中...');
            await saveStateToStorage();

            await chrome.tabs.reload(tabId);
            await sleep(3000);

            pendingDownloadTabs.push(tabId);

            broadcastStatusUpdate(tabId, 'in-progress', 'ダウンロード開始...');

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
