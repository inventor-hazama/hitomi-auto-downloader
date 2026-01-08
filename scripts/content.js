// Content Script - runs on hitomi.la pages
// Updated with verified selectors from browser analysis

// Report ready status to background
chrome.runtime.sendMessage({ type: 'CONTENT_READY', url: window.location.href });

// Listen for click commands from background/popup
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
 * Based on verified analysis: #dl-button (a tag with h1 "Download" inside)
 */
function findAndClickDownload() {
    console.log('[Hitomi Downloader] Searching for download button...');

    // Priority 1: Direct ID selector (verified from browser analysis)
    const dlButton = document.getElementById('dl-button');
    if (dlButton) {
        const rect = dlButton.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0;
        const displayStyle = window.getComputedStyle(dlButton).display;

        if (isVisible && displayStyle !== 'none') {
            console.log('[Hitomi Downloader] Found #dl-button, clicking...');
            dlButton.click();

            // Start monitoring progress
            startProgressMonitor();

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
            startProgressMonitor();
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
                startProgressMonitor();
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
 * Check download progress using #progressbar
 */
function checkDownloadProgress() {
    const progressbar = document.getElementById('progressbar');
    const dlButton = document.getElementById('dl-button');

    if (progressbar) {
        const value = progressbar.getAttribute('aria-valuenow');
        const progressValue = parseInt(value || '0', 10);
        const isVisible = window.getComputedStyle(progressbar).display !== 'none';

        return {
            status: 'downloading',
            progress: progressValue,
            visible: isVisible
        };
    }

    // If no progress bar but button is visible, download might be complete or not started
    if (dlButton) {
        const isVisible = window.getComputedStyle(dlButton).display !== 'none';
        if (isVisible) {
            return { status: 'ready', progress: 0 };
        }
    }

    return { status: 'unknown', progress: 0 };
}

/**
 * Monitor progress and report completion
 */
let progressMonitorInterval = null;

function startProgressMonitor() {
    if (progressMonitorInterval) {
        clearInterval(progressMonitorInterval);
    }

    let lastProgress = 0;
    let downloadStarted = false;

    progressMonitorInterval = setInterval(() => {
        const progressbar = document.getElementById('progressbar');
        const dlButton = document.getElementById('dl-button');

        if (progressbar) {
            downloadStarted = true;
            const progress = parseInt(progressbar.getAttribute('aria-valuenow') || '0', 10);

            if (progress !== lastProgress) {
                lastProgress = progress;
                chrome.runtime.sendMessage({
                    type: 'DOWNLOAD_PROGRESS',
                    progress: progress
                });
                console.log(`[Hitomi Downloader] Progress: ${progress}%`);
            }

            if (progress >= 100) {
                // Wait a bit for the actual download to complete
                setTimeout(() => {
                    chrome.runtime.sendMessage({ type: 'DOWNLOAD_COMPLETE' });
                    clearInterval(progressMonitorInterval);
                    progressMonitorInterval = null;
                }, 2000);
            }
        } else if (downloadStarted) {
            // Progress bar disappeared - download complete
            chrome.runtime.sendMessage({ type: 'DOWNLOAD_COMPLETE' });
            clearInterval(progressMonitorInterval);
            progressMonitorInterval = null;
        }
    }, 1000);

    // Safety timeout - stop monitoring after 10 minutes
    setTimeout(() => {
        if (progressMonitorInterval) {
            clearInterval(progressMonitorInterval);
            progressMonitorInterval = null;
        }
    }, 600000);
}

// Export for debugging
window.__hitomiDownloader = {
    findAndClickDownload,
    checkDownloadProgress,
    startProgressMonitor,
    version: '1.1.0'
};
