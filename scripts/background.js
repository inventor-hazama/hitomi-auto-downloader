// Background Service Worker

// State management
const downloadState = new Map();  // tabId -> { status, downloadId, details, progress }

// Listen for commands (keyboard shortcuts)
chrome.commands.onCommand.addListener(async (command) => {
    if (command === 'download-all') {
        await startDownloadsFromShortcut();
    }
});

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case 'START_DOWNLOADS':
            handleStartDownloads(message.tabIds, message.delay)
                .then(() => sendResponse({ success: true }))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;  // Keep message channel open for async response

        case 'GET_STATUS':
            const downloads = {};
            for (const [tabId, state] of downloadState) {
                downloads[tabId] = state;
            }
            sendResponse({ downloads });
            return false;

        case 'DOWNLOAD_CLICKED':
            // Content script reports that download button was clicked
            updateTabState(sender.tab.id, 'in-progress', 'ボタンクリック完了');
            sendResponse({ success: true });
            return false;

        case 'DOWNLOAD_PROGRESS':
            // Content script reports download progress
            if (sender.tab) {
                updateTabState(sender.tab.id, 'in-progress', `${message.progress}%`);
                broadcastProgressUpdate(sender.tab.id, message.progress);
            }
            sendResponse({ success: true });
            return false;

        case 'DOWNLOAD_COMPLETE':
            if (sender.tab) {
                updateTabState(sender.tab.id, 'complete', '');
            }
            sendResponse({ success: true });
            return false;

        case 'DOWNLOAD_ERROR':
            if (sender.tab) {
                updateTabState(sender.tab.id, 'error', message.error);
            }
            sendResponse({ success: true });
            return false;

        case 'RETRY_DOWNLOADS':
            handleRetryDownloads(message.tabIds, message.delay)
                .then(() => sendResponse({ success: true }))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;  // Keep message channel open for async response
    }
});

// Download progress monitoring (for file downloads)
chrome.downloads.onChanged.addListener((delta) => {
    // Find which tab this download belongs to
    for (const [tabId, state] of downloadState) {
        if (state.downloadId === delta.id) {
            if (delta.state) {
                if (delta.state.current === 'complete') {
                    updateTabState(tabId, 'complete', '');
                } else if (delta.state.current === 'interrupted') {
                    updateTabState(tabId, 'error', delta.error?.current || 'ダウンロード中断');
                }
            }
            break;
        }
    }
});

// Track new downloads to associate with tabs
chrome.downloads.onCreated.addListener((downloadItem) => {
    // Check if this download is from hitomi.la
    if (downloadItem.url && downloadItem.url.includes('hitomi.la')) {
        // Try to find the tab that initiated this download
        chrome.tabs.query({ url: '*://hitomi.la/*' }, (tabs) => {
            for (const tab of tabs) {
                const state = downloadState.get(tab.id);
                if (state && state.status === 'in-progress' && !state.downloadId) {
                    state.downloadId = downloadItem.id;
                    downloadState.set(tab.id, state);
                    break;
                }
            }
        });
    }
});

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
            // Initialize state
            downloadState.set(tabId, { status: 'in-progress', downloadId: null, details: '処理中...', progress: 0 });
            broadcastStatusUpdate(tabId, 'in-progress', '処理中...');

            // Execute content script to click download button
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: clickDownloadButton
            });

            // Wait between tabs to avoid overwhelming the server
            if (i < tabIds.length - 1) {
                await sleep(delay);
            }
        } catch (error) {
            console.error(`Error processing tab ${tabId}:`, error);
            updateTabState(tabId, 'error', error.message);
        }
    }
}

/**
 * 未完了タブをリロードして再ダウンロード
 * @param {number[]} tabIds - リロードするタブIDの配列
 * @param {number} delay - 各タブ間の待機時間（ms）
 */
async function handleRetryDownloads(tabIds, delay = 2000) {
    for (let i = 0; i < tabIds.length; i++) {
        const tabId = tabIds[i];

        try {
            // Reset state
            downloadState.set(tabId, { status: 'in-progress', downloadId: null, details: 'リロード中...', progress: 0 });
            broadcastStatusUpdate(tabId, 'in-progress', 'リロード中...');

            // Reload the tab
            await chrome.tabs.reload(tabId);

            // Wait for page to load (give more time for reload)
            await sleep(3000);

            // Update status
            broadcastStatusUpdate(tabId, 'in-progress', 'ダウンロード開始...');

            // Execute content script to click download button
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: clickDownloadButton
            });

            // Wait between tabs to avoid overwhelming the server
            if (i < tabIds.length - 1) {
                await sleep(delay);
            }
        } catch (error) {
            console.error(`Error retrying tab ${tabId}:`, error);
            updateTabState(tabId, 'error', error.message);
        }
    }
}

function updateTabState(tabId, status, details) {
    const state = downloadState.get(tabId) || { downloadId: null, progress: 0 };
    state.status = status;
    state.details = details;
    downloadState.set(tabId, state);

    broadcastStatusUpdate(tabId, status, details);
}

function broadcastStatusUpdate(tabId, status, details) {
    chrome.runtime.sendMessage({
        type: 'STATUS_UPDATE',
        tabId: tabId,
        status: status,
        details: details
    }).catch(() => {
        // Popup might not be open, that's fine
    });
}

function broadcastProgressUpdate(tabId, progress) {
    chrome.runtime.sendMessage({
        type: 'DOWNLOAD_PROGRESS',
        tabId: tabId,
        progress: progress
    }).catch(() => {
        // Popup might not be open, that's fine
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Function to be injected into content page
// Uses verified selector: #dl-button (from browser analysis)
function clickDownloadButton() {
    console.log('[Hitomi Downloader] clickDownloadButton called');

    // Priority 1: Direct ID selector (verified from browser analysis)
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
            // Button might be hidden - check for progress bar
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

    // Fallback: Look for a tag with h1 containing "Download"
    const downloadH1 = document.querySelector('a h1');
    if (downloadH1 && downloadH1.textContent.trim() === 'Download') {
        const parentLink = downloadH1.closest('a');
        if (parentLink) {
            console.log('[Hitomi Downloader] Found download link via h1...');
            parentLink.click();
            return { success: true, method: 'h1', element: 'a > h1' };
        }
    }

    // Fallback 2: Text-based search
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

    // Not found
    return { success: false, error: 'Download button not found' };
}
