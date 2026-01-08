// Popup UI Logic
document.addEventListener('DOMContentLoaded', init);

// State
let tabsState = new Map();

async function init() {
  await refreshTabList();

  document.getElementById('startDownload').addEventListener('click', startDownloadAll);
  document.getElementById('refreshStatus').addEventListener('click', refreshTabList);
  document.getElementById('retryDownload').addEventListener('click', retryIncomplete);

  // Listen for status updates from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'STATUS_UPDATE') {
      updateTabStatus(message.tabId, message.status, message.details);
    } else if (message.type === 'DOWNLOAD_PROGRESS') {
      updateDownloadProgress(message.tabId, message.progress);
    }
  });
}

async function refreshTabList() {
  try {
    const tabs = await chrome.tabs.query({
      currentWindow: true,
      url: '*://hitomi.la/*'
    });

    // Filter to content pages (not search/list pages)
    const contentTabs = tabs.filter(tab =>
      tab.url &&
      (tab.url.includes('/doujinshi/') ||
        tab.url.includes('/manga/') ||
        tab.url.includes('/gamecg/') ||
        tab.url.includes('/cg/') ||
        tab.url.includes('/anime/') ||
        tab.url.includes('/imageset/'))
    );

    // Update state
    tabsState = new Map(contentTabs.map(tab => [
      tab.id,
      {
        id: tab.id,
        title: tab.title || 'Unknown',
        url: tab.url,
        status: 'pending',
        details: ''
      }
    ]));

    renderTabList();
    updateStats();

    // Get current status from background
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (response && response.downloads) {
      for (const [tabId, status] of Object.entries(response.downloads)) {
        if (tabsState.has(parseInt(tabId))) {
          updateTabStatus(parseInt(tabId), status.status, status.details);
        }
      }
    }
  } catch (error) {
    console.error('Failed to refresh tab list:', error);
  }
}

function renderTabList() {
  const listElement = document.getElementById('tabList');

  if (tabsState.size === 0) {
    listElement.innerHTML = '<li class="empty-state">対象タブがありません</li>';
    return;
  }

  listElement.innerHTML = '';

  for (const [tabId, tab] of tabsState) {
    const li = document.createElement('li');
    li.dataset.tabId = tabId;

    const statusIcon = document.createElement('span');
    statusIcon.className = `status-icon status-${tab.status}`;
    statusIcon.textContent = getStatusEmoji(tab.status);

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = cleanTitle(tab.title);
    title.title = tab.title;

    const statusText = document.createElement('span');
    statusText.className = 'tab-status-text';
    statusText.textContent = getStatusText(tab.status, tab.details);

    li.appendChild(statusIcon);
    li.appendChild(title);
    li.appendChild(statusText);
    listElement.appendChild(li);
  }
}

function cleanTitle(title) {
  // Remove site name suffix
  return title.replace(/\s*\|\s*Hitomi\.la$/i, '').trim();
}

function getStatusEmoji(status) {
  const emojis = {
    'pending': '○',
    'in-progress': '◐',
    'complete': '✓',
    'error': '✕'
  };
  return emojis[status] || '○';
}

function getStatusText(status, details) {
  const texts = {
    'pending': '待機中',
    'in-progress': details || 'ダウンロード中...',
    'complete': '完了',
    'error': details || 'エラー'
  };
  return texts[status] || status;
}

function updateTabStatus(tabId, status, details = '') {
  if (tabsState.has(tabId)) {
    const tab = tabsState.get(tabId);
    tab.status = status;
    tab.details = details;
    tabsState.set(tabId, tab);

    // Update UI
    const li = document.querySelector(`li[data-tab-id="${tabId}"]`);
    if (li) {
      const statusIcon = li.querySelector('.status-icon');
      const statusText = li.querySelector('.tab-status-text');

      statusIcon.className = `status-icon status-${status}`;
      statusIcon.textContent = getStatusEmoji(status);
      statusText.textContent = getStatusText(status, details);
    }

    updateStats();
  }
}

function updateDownloadProgress(tabId, progress) {
  updateTabStatus(tabId, 'in-progress', `${Math.round(progress)}%`);
}

function updateStats() {
  let complete = 0;
  let inProgress = 0;
  let error = 0;

  for (const tab of tabsState.values()) {
    if (tab.status === 'complete') complete++;
    else if (tab.status === 'in-progress') inProgress++;
    else if (tab.status === 'error') error++;
  }

  document.getElementById('totalTabs').textContent = tabsState.size;
  document.getElementById('completedCount').textContent = complete;
  document.getElementById('inProgressCount').textContent = inProgress;
  document.getElementById('errorCount').textContent = error;
}

async function startDownloadAll() {
  const btn = document.getElementById('startDownload');
  btn.disabled = true;
  btn.innerHTML = '<span class="icon">⏳</span> 処理中...';

  try {
    const tabIds = Array.from(tabsState.keys());

    if (tabIds.length === 0) {
      alert('対象となるhitomi.laのタブがありません');
      return;
    }

    // Mark all as in-progress
    for (const tabId of tabIds) {
      updateTabStatus(tabId, 'in-progress', '開始中...');
    }

    // Send message to background to start downloads
    const response = await chrome.runtime.sendMessage({
      type: 'START_DOWNLOADS',
      tabIds: tabIds,
      delay: 1000  // 1 second delay between each tab
    });

    if (!response.success) {
      console.error('Failed to start downloads:', response.error);
    }
  } catch (error) {
    console.error('Error starting downloads:', error);
    alert('ダウンロード開始中にエラーが発生しました: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="icon">▶</span> 全タブでダウンロード開始';
  }
}

/**
 * 未完了のタブをリロードして再ダウンロード
 * 対象: pending, in-progress, error ステータスのタブ（completeは除外）
 */
async function retryIncomplete() {
  const btn = document.getElementById('retryDownload');
  btn.disabled = true;
  btn.innerHTML = '<span class="icon">⏳</span> リロード中...';

  try {
    // 未完了のタブを抽出（complete以外すべて）
    const incompleteTabs = [];
    for (const [tabId, tab] of tabsState) {
      if (tab.status !== 'complete') {
        incompleteTabs.push(tabId);
      }
    }

    if (incompleteTabs.length === 0) {
      alert('未完了のタブがありません。すべて完了しています。');
      return;
    }

    // 確認ダイアログ
    const confirmed = confirm(`${incompleteTabs.length}個の未完了タブをリロードして再ダウンロードしますか？`);
    if (!confirmed) {
      return;
    }

    // 各タブをリロードして再ダウンロード
    for (const tabId of incompleteTabs) {
      updateTabStatus(tabId, 'pending', 'リロード中...');
    }

    // バックグラウンドに再ダウンロードをリクエスト
    const response = await chrome.runtime.sendMessage({
      type: 'RETRY_DOWNLOADS',
      tabIds: incompleteTabs,
      delay: 2000  // リロード後の待機時間を少し長めに
    });

    if (!response.success) {
      console.error('Failed to retry downloads:', response.error);
      alert('再ダウンロードの開始に失敗しました: ' + response.error);
    }
  } catch (error) {
    console.error('Error retrying downloads:', error);
    alert('再ダウンロード中にエラーが発生しました: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="icon">🔁</span> 未完了を再ダウンロード';
  }
}
