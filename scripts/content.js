// Content Script - runs on hitomi.la pages
// シンプル版 - 進捗監視はバックグラウンドで行う

// Report ready status to background
chrome.runtime.sendMessage({ type: 'CONTENT_READY', url: window.location.href });

// Listen for commands from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'CLICK_DOWNLOAD') {
        const result = findAndClickDownload();
        sendResponse(result);
        return true;
    }
    if (message.type === 'CHECK_PROGRESS') {
        const progress = checkDownloadProgress();
        sendResponse(progress);
        return true;
    }
});

/**
 * Find and click the download button
 */
function findAndClickDownload() {
    console.log('[Hitomi Downloader] Searching for download button...');

    // Priority 1: Direct ID selector
    const dlButton = document.getElementById('dl-button');
    if (dlButton) {
        const rect = dlButton.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0;
        const displayStyle = window.getComputedStyle(dlButton).display;

        if (isVisible && displayStyle !== 'none') {
            console.log('[Hitomi Downloader] Found #dl-button, clicking...');
            dlButton.click();
            chrome.runtime.sendMessage({ type: 'DOWNLOAD_CLICKED' });
            return { success: true, method: 'id', element: '#dl-button' };
        } else {
            // Button exists but hidden - might already be downloading
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
            chrome.runtime.sendMessage({ type: 'DOWNLOAD_CLICKED' });
            return { success: true, method: 'h1', element: 'a > h1' };
        }
    }

    // Fallback 2: Text-based search
    const allElements = document.querySelectorAll('a, button');
    for (const element of allElements) {
        const text = element.textContent.trim();
        if (text === 'Download' || text === 'ダウンロード') {
            const rect = element.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                console.log('[Hitomi Downloader] Found by text:', element);
                element.click();
                chrome.runtime.sendMessage({ type: 'DOWNLOAD_CLICKED' });
                return { success: true, method: 'text', element: element.tagName };
            }
        }
    }

    // Not found
    const error = 'Download button not found on this page';
    console.error('[Hitomi Downloader]', error);
    chrome.runtime.sendMessage({ type: 'DOWNLOAD_ERROR', error: error });
    return { success: false, error: error };
}

/**
 * Check download progress - called by background via polling
 */
function checkDownloadProgress() {
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

    // If no progress bar but button is visible, download might be complete or not started
    if (dlButton) {
        const isVisible = window.getComputedStyle(dlButton).display !== 'none';
        if (isVisible) {
            return { status: 'ready', progress: 0, dlButtonVisible: true };
        }
    }

    // Neither visible - likely complete
    return { status: 'complete', progress: 100, dlButtonVisible: false };
}

// Export for debugging
window.__hitomiDownloader = {
    findAndClickDownload,
    checkDownloadProgress,
    version: '2.0.0'
};
