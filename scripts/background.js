// Background Service Worker
// v2.6.0 - 類似タイトル対策（話数・番号を重視）

// ============================================
// State Management
// ============================================

let downloadState = new Map();
let monitoredTabs = new Set();
let progressPollingInterval = null;
let unmatchedDownloads = new Map();

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

// ============================================
// 文字列マッチング関数（改良版）
// ============================================

function cleanTitle(title) {
    if (!title) return '';
    return title.replace(/\s*\|\s*Hitomi\.la.*$/i, '').trim();
}

function cleanFilename(filepath) {
    if (!filepath) return '';
    const filename = filepath.split(/[\\\/]/).pop() || filepath;
    return filename.replace(/\.zip$/i, '').trim();
}

function extractGalleryId(url) {
    if (!url) return null;
    const match = url.match(/-(\d+)\.html/);
    return match ? match[1] : null;
}

// 話数・番号を抽出（複数パターン対応）
function extractEpisodeNumbers(str) {
    if (!str) return [];

    const numbers = [];

    // 第N話、第N巻、第N章 など
    const japanesePatterns = str.matchAll(/第([0-9０-９一二三四五六七八九十百]+)[話巻章部編]/g);
    for (const m of japanesePatterns) {
        numbers.push(normalizeNumber(m[1]));
    }

    // (N), [N], Vol.N, Part N, Episode N など
    const englishPatterns = str.matchAll(/(?:Vol\.?|Part|Episode|Ep\.?|Ch\.?|Chapter)\s*([0-9]+)/gi);
    for (const m of englishPatterns) {
        numbers.push(parseInt(m[1]));
    }

    // 末尾の数字 "タイトル 1" "タイトル2" など
    const trailingNumber = str.match(/\s*(\d+)\s*$/);
    if (trailingNumber) {
        numbers.push(parseInt(trailingNumber[1]));
    }

    // 括弧内の数字
    const bracketNumbers = str.matchAll(/[(\[（【](\d+)[)\]）】]/g);
    for (const m of bracketNumbers) {
        numbers.push(parseInt(m[1]));
    }

    return [...new Set(numbers)];  // 重複除去
}

// 全角数字や漢数字を半角数字に変換
function normalizeNumber(str) {
    const zenToHan = { '０': 0, '１': 1, '２': 2, '３': 3, '４': 4, '５': 5, '６': 6, '７': 7, '８': 8, '９': 9 };
    const kanjiToNum = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };

    if (/^[0-9]+$/.test(str)) return parseInt(str);

    let result = '';
    for (const char of str) {
        if (zenToHan[char] !== undefined) result += zenToHan[char];
        else if (kanjiToNum[char] !== undefined) result += kanjiToNum[char];
        else result += char;
    }

    return parseInt(result) || 0;
}

// 正規化
function normalizeForComparison(str) {
    if (!str) return '';
    return str
        .toLowerCase()
        .replace(/[「」『』【】\[\]()（）\{\}<>《》♡♥★☆]/g, '')
        .replace(/[.\-_～~→]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// マッチスコア計算（改良版）
function calculateMatchScore(filename, tabTitle, galleryId) {
    const cleanedFilename = cleanFilename(filename);
    const cleanedTitle = cleanTitle(tabTitle);

    console.log(`[Background]     fn: "${cleanedFilename.substring(0, 40)}"`);
    console.log(`[Background]     tt: "${cleanedTitle.substring(0, 40)}"`);

    // 1. ギャラリーIDチェック（最優先）
    if (galleryId && (filename.includes(galleryId) || cleanedFilename.includes(galleryId))) {
        console.log(`[Background]     → galleryId match (${galleryId})`);
        return 100;
    }

    // 2. 完全一致
    if (cleanedFilename === cleanedTitle) {
        console.log(`[Background]     → exact match`);
        return 100;
    }

    // 3. 正規化して比較
    const normFilename = normalizeForComparison(cleanedFilename);
    const normTitle = normalizeForComparison(cleanedTitle);

    if (normFilename === normTitle) {
        console.log(`[Background]     → normalized exact match`);
        return 98;
    }

    // 4. 話数・番号の比較（重要！）
    const filenameNums = extractEpisodeNumbers(cleanedFilename);
    const titleNums = extractEpisodeNumbers(cleanedTitle);

    console.log(`[Background]     fn nums: [${filenameNums.join(', ')}]`);
    console.log(`[Background]     tt nums: [${titleNums.join(', ')}]`);

    if (filenameNums.length > 0 && titleNums.length > 0) {
        // 両方に番号がある場合、番号が一致しなければ大幅減点
        const hasCommonNumber = filenameNums.some(n => titleNums.includes(n));
        if (!hasCommonNumber) {
            console.log(`[Background]     → episode number MISMATCH`);
            return 10;  // 番号不一致は非常に低スコア
        } else {
            console.log(`[Background]     → episode number match`);
        }
    }

    // 5. 含有チェック
    if (normFilename.includes(normTitle) || normTitle.includes(normFilename)) {
        console.log(`[Background]     → contains match`);
        return 85;
    }

    // 6. 先頭文字列一致
    const minLen = Math.min(normFilename.length, normTitle.length);
    const compareLen = Math.min(minLen, 25);

    if (compareLen > 5) {
        const prefixFilename = normFilename.substring(0, compareLen);
        const prefixTitle = normTitle.substring(0, compareLen);

        if (prefixFilename === prefixTitle) {
            console.log(`[Background]     → prefix match (${compareLen} chars)`);
            return 80;
        }
    }

    // 7. 文字レベル類似度（Dice係数の簡易版）
    const bigrams1 = getBigrams(normFilename);
    const bigrams2 = getBigrams(normTitle);
    const intersection = bigrams1.filter(b => bigrams2.includes(b)).length;
    const similarity = (2 * intersection) / (bigrams1.length + bigrams2.length);
    const similarityScore = Math.round(similarity * 70);

    console.log(`[Background]     → similarity: ${(similarity * 100).toFixed(1)}% = score ${similarityScore}`);

    return similarityScore;
}

// 2-gramを取得
function getBigrams(str) {
    const bigrams = [];
    for (let i = 0; i < str.length - 1; i++) {
        bigrams.push(str.substring(i, i + 2));
    }
    return bigrams;
}

// マッチング実行
async function matchDownloadToTab(downloadId, filename, url) {
    console.log(`[Background] === Matching download ${downloadId} ===`);
    console.log(`[Background] File: "${filename}"`);

    let bestMatch = null;
    let bestScore = 0;

    const candidates = [];

    for (const [tabId, state] of downloadState) {
        if (state.status !== 'in-progress') continue;
        if (state.downloadId) continue;

        const score = calculateMatchScore(filename, state.title, state.galleryId);
        candidates.push({ tabId, score, title: state.title?.substring(0, 40) });

        if (score > bestScore) {
            bestScore = score;
            bestMatch = tabId;
        }
    }

    // 候補をスコア順でログ出力
    candidates.sort((a, b) => b.score - a.score);
    console.log('[Background] Candidates:');
    for (const c of candidates.slice(0, 5)) {
        console.log(`[Background]   ${c.score}: tab ${c.tabId} "${c.title}"`);
    }

    // 閾値チェック（30に設定）
    if (bestMatch !== null && bestScore >= 30) {
        const state = downloadState.get(bestMatch);
        state.downloadId = downloadId;
        downloadState.set(bestMatch, state);
        await saveStateToStorage();
        console.log(`[Background] ✓ MATCHED: download ${downloadId} -> tab ${bestMatch} (score: ${bestScore})`);
        return true;
    }

    console.log(`[Background] ✗ No match (best: ${bestScore})`);
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
    console.log('[Background] Download created:', downloadItem.id);

    if (downloadItem.filename) {
        const matched = await matchDownloadToTab(downloadItem.id, downloadItem.filename, downloadItem.url);
        if (!matched) {
            unmatchedDownloads.set(downloadItem.id, { filename: downloadItem.filename, url: downloadItem.url });
        }
    } else {
        unmatchedDownloads.set(downloadItem.id, { filename: null, url: downloadItem.url });
    }
});

chrome.downloads.onChanged.addListener(async (delta) => {
    if (delta.filename && delta.filename.current) {
        const info = unmatchedDownloads.get(delta.id);
        if (info && !info.filename) {
            console.log(`[Background] Filename ready: ${delta.id}: ${delta.filename.current}`);
            info.filename = delta.filename.current;
            const matched = await matchDownloadToTab(delta.id, delta.filename.current, info.url);
            if (matched) {
                unmatchedDownloads.delete(delta.id);
            }
        }
    }

    if (delta.state) {
        for (const [tabId, state] of downloadState) {
            if (state.downloadId === delta.id) {
                if (delta.state.current === 'complete') {
                    console.log(`[Background] ✓ COMPLETE: ${delta.id} -> tab ${tabId}`);
                    updateTabState(tabId, 'complete', '');
                    monitoredTabs.delete(tabId);
                    unmatchedDownloads.delete(delta.id);
                    await saveStateToStorage();
                } else if (delta.state.current === 'interrupted') {
                    console.log(`[Background] ✗ INTERRUPTED: ${delta.id} -> tab ${tabId}`);
                    updateTabState(tabId, 'error', delta.error?.current || '中断');
                    monitoredTabs.delete(tabId);
                    unmatchedDownloads.delete(delta.id);
                    await saveStateToStorage();
                }
                return;
            }
        }

        if (delta.state.current === 'complete') {
            const info = unmatchedDownloads.get(delta.id);
            if (info && info.filename) {
                console.log(`[Background] Retry match for completed: ${delta.id}`);
                const matched = await matchDownloadToTab(delta.id, info.filename, info.url);
                if (matched) {
                    for (const [tabId, state] of downloadState) {
                        if (state.downloadId === delta.id) {
                            updateTabState(tabId, 'complete', '');
                            monitoredTabs.delete(tabId);
                            break;
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

            console.log(`[Background] Starting: ${tabId} "${tab.title?.substring(0, 50)}" (gid: ${galleryId})`);

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
