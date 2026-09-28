// Chrono background service worker: owns Groq transcription jobs so closing
// the popup no longer kills an in-flight transcription.
importScripts("./groq-pipeline.js");

const GROQ_JOB_KEY_PREFIX = "chronoGroqJob:";
const GROQ_JOB_INDEX_KEY = "chronoGroqJobs";
const KEEP_ALIVE_MS = 20000;

let keepAliveTimer = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "CHRONO_GROQ_START") {
    startGroqJob(message.payload || {}).then(
      (job) => sendResponse({ ok: true, data: job }),
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

  if (message.type === "CHRONO_GROQ_STATUS") {
    readGroqJob(message.payload?.jobId).then(
      (job) => sendResponse({ ok: true, data: job }),
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

  if (message.type === "CHRONO_GROQ_DISMISS") {
    dismissGroqJob(message.payload?.jobId).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

  return false;
});

// MV3 may suspend this worker mid-job; pollers re-wake it via STATUS pings.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "CHRONO_GROQ_KEEPALIVE") return;
  beginKeepAlive();
  port.onDisconnect.addListener(() => endKeepAlive());
});

function beginKeepAlive() {
  endKeepAlive();
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {
      if (chrome.runtime.lastError) endKeepAlive();
    });
  }, KEEP_ALIVE_MS);
}

function endKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

async function startGroqJob(payload) {
  const jobId = `groq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    jobId,
    status: "starting",
    progress: "正在准备转录任务…",
    sliceIndex: 0,
    sliceTotal: 0,
    platform: payload.platform || "",
    videoId: payload.videoId || "",
    url: payload.tabUrl || "",
    title: payload.title || "",
    author: payload.author || "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: null,
    error: null
  };
  await writeGroqJob(job);
  // Run async; the popup polls STATUS until done/failed.
  runGroqJob(jobId, payload).catch(() => {});
  return sanitizeJob(job);
}

async function runGroqJob(jobId, payload) {
  try {
    await updateGroqJob(jobId, { status: "fetching-audio", progress: "正在获取音频地址…" });
    const audioSource = await sendToTab(payload.tabId, payload.getAudioMessageType, payload.getAudioPayload || {});
    if (!audioSource?.url) throw new Error("当前页面没有返回可用音频地址。");

    await updateGroqJob(jobId, { status: "downloading", progress: "正在下载音频…" });
    let audioBlob;
    try {
      audioBlob = await fetchAudioBlob(audioSource, payload.platform, payload.tabUrl);
    } catch (error) {
      if (![401, 403, 404, 410].includes(error?.httpStatus)) throw error;
      await updateGroqJob(jobId, { status: "refreshing", progress: "音频地址已过期，正在刷新后重试…" });
      audioSource = await sendToTab(payload.tabId, payload.getAudioMessageType, { forceRefresh: true });
      audioBlob = await fetchAudioBlob(audioSource, payload.platform, payload.tabUrl);
    }

    await updateGroqJob(jobId, { status: "transcribing", progress: "正在切片并调用 Groq Whisper…" });
    const sliceResults = await transcribeAudioSlices(jobId, audioBlob, payload);
    const result = normalizeGroqSlices(sliceResults, {
      platform: payload.platform,
      videoId: payload.videoId || audioSource.videoId,
      url: payload.tabUrl,
      title: payload.title || "未命名视频",
      author: payload.author || "",
      language: payload.language
    });
    await updateGroqJob(jobId, {
      status: "done",
      progress: `Groq 转录完成，已提取 ${result.segments.length} 段。`,
      sliceIndex: sliceResults.length,
      sliceTotal: sliceResults.length,
      result
    });
  } catch (error) {
    await updateGroqJob(jobId, {
      status: "failed",
      progress: "",
      error: error?.message || "Groq 转录失败。"
    });
  }
}

function sendToTab(tabId, type, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!tabId || !type) {
      reject(new Error("转录任务缺少页面信息。"));
      return;
    }
    chrome.tabs.sendMessage(tabId, { type, payload }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || "Could not connect to the content script."));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Request failed."));
        return;
      }
      resolve(response.data);
    });
  });
}

async function updateGroqJob(jobId, patch) {
  const job = await readGroqJob(jobId);
  if (!job) return null;
  const next = { ...job, ...patch, jobId, updatedAt: Date.now() };
  await writeGroqJob(next);
  return sanitizeJob(next);
}

async function writeGroqJob(job) {
  const key = `${GROQ_JOB_KEY_PREFIX}${job.jobId}`;
  await chrome.storage.local.set({ [key]: job });
  const stored = await chrome.storage.local.get([GROQ_JOB_INDEX_KEY]);
  const index = Array.isArray(stored[GROQ_JOB_INDEX_KEY]) ? stored[GROQ_JOB_INDEX_KEY] : [];
  if (!index.includes(job.jobId)) {
    index.push(job.jobId);
    await chrome.storage.local.set({ [GROQ_JOB_INDEX_KEY]: index.slice(-10) });
  }
}

async function readGroqJob(jobId) {
  if (!jobId) throw new Error("缺少转录任务 ID。");
  const stored = await chrome.storage.local.get([`${GROQ_JOB_KEY_PREFIX}${jobId}`]);
  const job = stored[`${GROQ_JOB_KEY_PREFIX}${jobId}`];
  if (!job) throw new Error("转录任务不存在或已清理。");
  return job;
}

async function dismissGroqJob(jobId) {
  if (!jobId) return;
  await chrome.storage.local.remove([`${GROQ_JOB_KEY_PREFIX}${jobId}`]);
  const stored = await chrome.storage.local.get([GROQ_JOB_INDEX_KEY]);
  const index = Array.isArray(stored[GROQ_JOB_INDEX_KEY]) ? stored[GROQ_JOB_INDEX_KEY] : [];
  await chrome.storage.local.set({ [GROQ_JOB_INDEX_KEY]: index.filter((id) => id !== jobId) });
}

function sanitizeJob(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    sliceIndex: job.sliceIndex,
    sliceTotal: job.sliceTotal,
    platform: job.platform,
    videoId: job.videoId,
    url: job.url,
    title: job.title,
    author: job.author,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result,
    error: job.error
  };
}
