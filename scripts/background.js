// Background Service Worker
// 進捗監視とステータス永続化対応版

// ============================================
// State Management with chrome.storage.local
// ============================================

// メモリ内キャッシュ（高速アクセス用）
let downloadState = new Map();  // tabId -> { status, downloadId, details, progress, url }

// 監視中のタブ
let monitoredTabs = new Set();
let progressPollingInterval = null;

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
    const result = await chrome.storage.local.get('downloadState');
    if (result.downloadState) {
        downloadState = new Map(Object.entries(result.downloadState).map(
            ([k, v]) => [parseInt(k), v]
        ));
        console.log('[Background] Restored state:', downloadState.size, 'tabs');
    }
}

// 初期化時にステータスを復元
loadStateFromStorage();

// ============================================
// Progress Polling from Background
// ============================================

// バックグラウンドから各タブの進捗をポーリング
async function pollTabProgress(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: getProgressFromPage
        });

        if (results && results[0] && results[0].result) {
            const { status, progress, dlButtonVisible } = results[0].result;
            const currentState = downloadState.get(tabId);

            if (!currentState) return;

            if (status === 'downloading') {
                updateTabState(tabId, 'in-progress', `${progress}%`);
                if (progress >= 100) {
                    // 100%に達したら少し待って完了
                    setTimeout(() => {
                        updateTabState(tabId, 'complete', '');
                        monitoredTabs.delete(tabId);
                        saveStateToStorage();
                    }, 2000);
                }
            } else if (status === 'complete' || (status === 'ready' && currentState.status === 'in-progress' && currentState.progress >= 90)) {
                // プログレスバーが消えて、以前90%以上だった場合は完了
                updateTabState(tabId, 'complete', '');
                monitoredTabs.delete(tabId);
                saveStateToStorage();
            }
        }
    } catch (error) {
        // タブが閉じられた等の場合は監視を停止
        console.log(`[Background] Tab ${tabId} polling error:`, error.message);
        monitoredTabs.delete(tabId);
    }
}

// ページから進捗を取得する関数（タブに注入される）
function getProgressFromPage() {
    const progressbar = document.getElementById('progressbar');
    const dlButton = document.getElementById('dl-button');

    if (progressbar) {
        const value = progressbar.getAttribute('aria-valuenow');
        const progressValue = parseInt(value || '0', 10);
        const isVisible = window.getComputedStyle(progressbar).display !== 'none';

        if (isVisible) {
            return {
                status: 'downloading',
                progress: progressValue,
                dlButtonVisible: false
            };
        }
    }

    // プログレスバーがない場合
    if (dlButton) {
        const isVisible = window.getComputedStyle(dlButton).display !== 'none';
        if (isVisible) {
            return { status: 'ready', progress: 0, dlButtonVisible: true };
        }
    }

    // どちらもない - ダウンロード完了か準備中
    return { status: 'complete', progress: 100, dlButtonVisible: false };
}

// ポーリングを開始
function startProgressPolling() {
    if (progressPollingInterval) {
        return; // 既に実行中
    }

    progressPollingInterval = setInterval(async () => {
        if (monitoredTabs.size === 0) {
            // 監視対象がなければ停止
            clearInterval(progressPollingInterval);
            progressPollingInterval = null;
            console.log('[Background] Polling stopped - no monitored tabs');
            return;
        }

        // 全監視タブをポーリング
        for (const tabId of monitoredTabs) {
            await pollTabProgress(tabId);
        }
    }, 2000); // 2秒間隔

    console.log('[Background] Polling started');
}

// タブを監視対象に追加
function addToMonitoring(tabId) {
    monitoredTabs.add(tabId);
    startProgressPolling();
}

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
                }
                updateTabState(sender.tab.id, 'in-progress', `${message.progress}%`);
                broadcastProgressUpdate(sender.tab.id, message.progress);
            }
            sendResponse({ success: true });
            return false;

        case 'DOWNLOAD_COMPLETE':
            if (sender.tab) {
                updateTabState(sender.tab.id, 'complete', '');
                monitoredTabs.delete(sender.tab.id);
                saveStateToStorage();
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

        case 'CLEAR_STATE':
            // 完了済みのステータスをクリア
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
// Chrome Downloads API Integration
// ============================================

chrome.downloads.onChanged.addListener((delta) => {
    for (const [tabId, state] of downloadState) {
        if (state.downloadId === delta.id) {
            if (delta.state) {
                if (delta.state.current === 'complete') {
                    updateTabState(tabId, 'complete', '');
                    monitoredTabs.delete(tabId);
                    saveStateToStorage();
                } else if (delta.state.current === 'interrupted') {
                    updateTabState(tabId, 'error', delta.error?.current || 'ダウンロード中断');
                    monitoredTabs.delete(tabId);
                }
            }
            break;
        }
    }
});

chrome.downloads.onCreated.addListener((downloadItem) => {
    if (downloadItem.url && downloadItem.url.includes('hitomi.la')) {
        chrome.tabs.query({ url: '*://hitomi.la/*' }, (tabs) => {
            for (const tab of tabs) {
                const state = downloadState.get(tab.id);
                if (state && state.status === 'in-progress' && !state.downloadId) {
                    state.downloadId = downloadItem.id;
                    downloadState.set(tab.id, state);
                    saveStateToStorage();
                    break;
                }
            }
        });
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

        if (contentTabs.length === 0) {
            console.log('No hitomi.la content tabs found');
            return;
        }

        await handleStartDownloads(contentTabs.map(t => t.id), 1000);
    } catch (error) {
        console.error('Error starting downloads from shortcut:', error);
    }
}

async function handleStartDownloads(tabIds, delay = 1000) {
    for (let i = 0; i < tabIds.length; i++) {
        const tabId = tabIds[i];

        try {
            // タブ情報を取得
            const tab = await chrome.tabs.get(tabId);

            // Initialize state
            downloadState.set(tabId, {
                status: 'in-progress',
                downloadId: null,
                details: '処理中...',
                progress: 0,
                url: tab.url,
                title: tab.title
            });
            broadcastStatusUpdate(tabId, 'in-progress', '処理中...');
            await saveStateToStorage();

            // Execute content script to click download button
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: clickDownloadButton
            });

            // 監視対象に追加
            addToMonitoring(tabId);

            // Wait between tabs
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
            // Reset state
            downloadState.set(tabId, {
                status: 'in-progress',
                downloadId: null,
                details: 'リロード中...',
                progress: 0
            });
            broadcastStatusUpdate(tabId, 'in-progress', 'リロード中...');
            await saveStateToStorage();

            // Reload the tab
            await chrome.tabs.reload(tabId);
            await sleep(3000);

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

    // 完了・エラー時は自動保存
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
            console.log('[Hitomi Downloader] Found download link via h1...');
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
                console.log('[Hitomi Downloader] Found by text:', element);
                element.click();
                return { success: true, method: 'text', element: element.tagName };
            }
        }
    }

    return { success: false, error: 'Download button not found' };
}
