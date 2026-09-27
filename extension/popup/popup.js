const state = {
  tab: null,
  metadata: null,
  tracks: [],
  collection: null,
  result: null,
  activeResult: null,
  groqSettings: {
    apiKeys: [],
    apiKey: "",
    model: "whisper-large-v3-turbo",
    language: "auto"
  },
  autoRunToken: 0
};

const RESULT_CACHE_KEY = "chronoLastSubtitleResult";
const RESULT_CACHE_CHUNK_PREFIX = "chronoLastSubtitleResultChunk";
const RESULT_CACHE_VERSION = 2;
const RESULT_CACHE_CHUNK_SIZE = 240000;
const JSON_TIME_FIELDS = new Set(["startSeconds", "endSeconds", "durationSeconds"]);

const GROQ_STORAGE_KEYS = ["groqApiKeys", "groqApiKey", "groqModel", "groqLanguage"];
const GROQ_DEFAULT_MODEL = "whisper-large-v3-turbo";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
// ~5min audio slices stay safely under Groq's 25MB upload limit without ffmpeg.
const GROQ_SLICE_SECONDS = 300;
const GROQ_SLICE_OVERLAP_SECONDS = 5;
const GROQ_SLICE_MAX_BYTES = 24 * 1024 * 1024;

const PLATFORM_CONFIG = {
  bilibili: {
    label: "Bilibili",
    authorLabel: "UP 主",
    messageTypes: {
      getTracks: "BCE_GET_BILIBILI_TRACKS",
      extractSubtitle: "BCE_EXTRACT_BILIBILI_SUBTITLE",
      getAudioSource: "BCE_GET_BILIBILI_AUDIO_SOURCE"
    },
    isVideoUrl: isBilibiliVideoUrl,
    parseVideoId: parseBilibiliVideoId,
    cleanTitle: cleanBilibiliTitle
  },
  youtube: {
    label: "YouTube",
    authorLabel: "频道",
    messageTypes: {
      getTracks: "BCE_GET_YOUTUBE_TRACKS",
      extractSubtitle: "BCE_EXTRACT_YOUTUBE_SUBTITLE",
      getAudioSource: "BCE_GET_YOUTUBE_AUDIO_SOURCE"
    },
    isVideoUrl: isYouTubeVideoUrl,
    parseVideoId: parseYouTubeVideoId,
    cleanTitle: cleanYouTubeTitle
  }
};

const EXPORT_FORMATS = {
  md: {
    extension: "md",
    mime: "text/markdown",
    build: buildMarkdown
  },
  json: {
    extension: "json",
    mime: "application/json",
    build: buildJson
  },
  srt: {
    extension: "srt",
    mime: "application/x-subrip",
    build: buildSrt
  },
  txt: {
    extension: "txt",
    mime: "text/plain",
    build: buildPlainText
  }
};

const BUTTON_ICON_HTML = {
  copyTextButton: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h10v12H8z"/><path d="M6 16H4V4h12v2"/></svg>',
  downloadMarkdownButton: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10"/><path d="m8 10 4 4 4-4"/><path d="M5 20h14"/></svg>',
  downloadJsonButton: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4H6a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h2"/><path d="M16 4h2a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-2"/></svg>',
  downloadSrtButton: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v16H7z"/><path d="M10 8h4M10 12h4M10 16h2"/></svg>',
  downloadTxtButton: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12v16H6z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>',
  extractCollectionButton: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h6l2 2h8v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M8 12h8M8 15h5"/></svg>'
};

const nodes = {
  pageStatus: document.getElementById("pageStatus"),
  videoId: document.getElementById("videoId"),
  videoTitle: document.getElementById("videoTitle"),
  videoAuthor: document.getElementById("videoAuthor"),
  statusCard: document.getElementById("statusCard"),
  autoStatusText: document.getElementById("autoStatusText"),
  resultPanel: document.getElementById("resultPanel"),
  segmentCount: document.getElementById("segmentCount"),
  selectedLanguage: document.getElementById("selectedLanguage"),
  preview: document.getElementById("preview"),
  collectionPanel: document.getElementById("collectionPanel"),
  collectionCount: document.getElementById("collectionCount"),
  collectionList: document.getElementById("collectionList"),
  copyTextButton: document.getElementById("copyTextButton"),
  downloadMarkdownButton: document.getElementById("downloadMarkdownButton"),
  downloadJsonButton: document.getElementById("downloadJsonButton"),
  downloadSrtButton: document.getElementById("downloadSrtButton"),
  downloadTxtButton: document.getElementById("downloadTxtButton"),
  trackSelect: document.getElementById("trackSelect"),
  switchTrackButton: document.getElementById("switchTrackButton"),
  noSubtitlePanel: document.getElementById("noSubtitlePanel"),
  transcribeButton: document.getElementById("transcribeButton"),
  groqProgress: document.getElementById("groqProgress"),
  extractFailedPanel: document.getElementById("extractFailedPanel"),
  extractFailedText: document.getElementById("extractFailedText"),
  retryExtractButton: document.getElementById("retryExtractButton"),
  fallbackGroqButton: document.getElementById("fallbackGroqButton"),
  groqFallbackProgress: document.getElementById("groqFallbackProgress"),
  toggleGroqSettingsButton: document.getElementById("toggleGroqSettingsButton"),
  groqSettings: document.getElementById("groqSettings"),
  groqApiKeyInput: document.getElementById("groqApiKeyInput"),
  groqModelInput: document.getElementById("groqModelInput"),
  groqLanguageInput: document.getElementById("groqLanguageInput"),
  saveGroqSettingsButton: document.getElementById("saveGroqSettingsButton"),
  message: document.getElementById("message")
};

init();

async function init() {
  bindEvents();
  await loadGroqSettings();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;

  const platform = getSupportedPlatform(tab?.url);
  if (!platform) {
    setStatus("不支持", "error");
    nodes.videoTitle.textContent = "请打开 B 站或 YouTube 视频页面";
    nodes.videoId.textContent = "-";
    nodes.statusCard.hidden = true;
    setMessage("支持 https://www.bilibili.com/video/BV... 和 https://www.youtube.com/watch?v=... 页面。", true);
    return;
  }

  const videoId = parsePlatformVideoId(tab.url, platform);
  setStatus("可提取", "ok");
  nodes.videoId.textContent = videoId || "-";
  nodes.videoTitle.textContent = tab.title ? cleanPlatformTitle(tab.title, platform) : `已检测到 ${getPlatformLabel(platform)} 视频`;
  const restored = await restoreCachedResult(platform, videoId);
  if (restored) return;
  await autoPrepareSubtitles();
}

function bindEvents() {
  nodes.copyTextButton.addEventListener("click", copyPlainText);
  nodes.downloadMarkdownButton.addEventListener("click", () => downloadText("md"));
  nodes.downloadJsonButton.addEventListener("click", () => downloadText("json"));
  nodes.downloadSrtButton.addEventListener("click", () => downloadText("srt"));
  nodes.downloadTxtButton.addEventListener("click", () => downloadText("txt"));
  nodes.switchTrackButton.addEventListener("click", switchTrackAndExtract);
  nodes.transcribeButton.addEventListener("click", () => transcribeWithGroq(nodes.groqProgress));
  nodes.retryExtractButton.addEventListener("click", () => autoPrepareSubtitles(true));
  nodes.fallbackGroqButton.addEventListener("click", () => transcribeWithGroq(nodes.groqFallbackProgress));
  nodes.toggleGroqSettingsButton.addEventListener("click", toggleGroqSettings);
  nodes.saveGroqSettingsButton.addEventListener("click", saveGroqSettings);
}

async function autoPrepareSubtitles(isRetry = false) {
  const runToken = ++state.autoRunToken;
  await refreshActiveTab();
  const platform = getSupportedPlatform(state.tab?.url);
  if (!platform) return;
  if (!isRetry) {
    const videoId = parsePlatformVideoId(state.tab?.url, platform);
    const restored = await restoreCachedResult(platform, videoId);
    if (restored && runToken === state.autoRunToken) return;
  }

  hideAllPanels();
  nodes.statusCard.hidden = false;
  setAutoStatus("正在读取字幕…");
  setMessage("正在读取字幕…");

  let metadata;
  try {
    metadata = await sendToContent(getMessageType("getTracks"));
  } catch (error) {
    if (runToken !== state.autoRunToken) return;
    showExtractFailed(error.message || "读取字幕轨道失败。");
    return;
  }

  if (runToken !== state.autoRunToken) return;
  state.metadata = metadata;
  state.tracks = metadata.availableTracks || [];
  state.collection = metadata.collection?.items?.length ? metadata.collection : null;
  state.result = null;
  state.activeResult = null;

  nodes.videoId.textContent = metadata.videoId || parsePlatformVideoId(state.tab.url, metadata.platform) || "-";
  nodes.videoTitle.textContent = metadata.title || "未命名视频";
  nodes.videoAuthor.textContent = metadata.author ? `${getPlatformAuthorLabel(metadata.platform)}：${metadata.author}` : "";

  renderTracks();

  if (!state.tracks.length) {
    nodes.statusCard.hidden = true;
    nodes.noSubtitlePanel.hidden = false;
    setMessage("当前视频没有可用字幕，可以使用 Groq 转录。");
    return;
  }

  const track = await pickBestTrackWithPreference(state.tracks);
  if (track) {
    nodes.trackSelect.value = track.id;
    nodes.switchTrackButton.disabled = false;
    try {
      await rememberPreferredLanguage(track.language);
    } catch (_error) {
      // Preferred language is best-effort only.
    }
  }

  setAutoStatus("正在提取字幕…");
  setMessage("正在提取字幕…");

  try {
    const data = await sendToContent(getMessageType("extractSubtitle"), {
      track,
      metadata: state.metadata,
      availableTracks: state.tracks
    });
    if (runToken !== state.autoRunToken) return;
    state.result = data;
    state.activeResult = data;
    renderResult(data);
    await saveResultCache();
    setMessage(`已提取 ${data.segments?.length || 0} 段。`);
  } catch (error) {
    if (runToken !== state.autoRunToken) return;
    showExtractFailed(error.message || "字幕提取失败。");
  }
}

function hideAllPanels() {
  nodes.statusCard.hidden = true;
  nodes.resultPanel.hidden = true;
  nodes.noSubtitlePanel.hidden = true;
  nodes.extractFailedPanel.hidden = true;
}

function setAutoStatus(text) {
  nodes.statusCard.hidden = false;
  nodes.autoStatusText.textContent = text;
}

function showExtractFailed(errorMessage) {
  nodes.statusCard.hidden = true;
  nodes.resultPanel.hidden = true;
  nodes.noSubtitlePanel.hidden = true;
  nodes.extractFailedPanel.hidden = false;
  nodes.extractFailedText.textContent = `平台字幕暂时无法读取：${errorMessage}`;
  setMessage(errorMessage, true);
}

function normalizeLanguage(value) {
  return String(value || "").toLowerCase().replace(/_/g, "-").split("-")[0];
}

function trackScore(track, preferredBase, browserBase) {
  const base = normalizeLanguage(track.language);
  const isAuto = track.source === "auto" || track.kind === "asr";
  let score = 1000;
  if (preferredBase && base === preferredBase) score -= 400;
  if (browserBase && base === browserBase) score -= 200;
  // Manual subtitles rank above auto subtitles; Bilibili marks normal tracks as unknown.
  if (!isAuto) score -= 150;
  return score;
}

async function pickBestTrackWithPreference(tracks) {
  if (!tracks?.length) return null;
  const stored = await chrome.storage.local.get(["chronoPreferredLanguage"]).catch(() => ({}));
  const preferredBase = normalizeLanguage(stored.chronoPreferredLanguage || "");
  const browserBase = normalizeLanguage(navigator.language || "zh");
  const ranked = [...tracks].sort((a, b) => {
    return trackScore(a, preferredBase, browserBase) - trackScore(b, preferredBase, browserBase);
  });
  return ranked[0];
}

async function rememberPreferredLanguage(language) {
  const base = normalizeLanguage(language);
  if (!base || base === "unknown") return;
  await chrome.storage.local.set({ chronoPreferredLanguage: base });
}

async function switchTrackAndExtract() {
  const track = state.tracks.find((item) => item.id === nodes.trackSelect.value);
  if (!track) {
    setMessage("请先选择字幕语言。", true);
    return;
  }
  try {
    await rememberPreferredLanguage(track.language);
  } catch (_error) {
    // Ignore storage failures.
  }
  setMessage("正在切换字幕并重新提取…");
  try {
    const data = await sendToContent(getMessageType("extractSubtitle"), {
      track,
      metadata: state.metadata,
      availableTracks: state.tracks
    });
    state.result = data;
    state.activeResult = data;
    renderResult(data);
    await saveResultCache();
    setMessage(`已提取 ${data.segments?.length || 0} 段。`);
  } catch (error) {
    setMessage(error.message, true);
  }
}

async function loadGroqSettings() {
  const stored = await chrome.storage.local.get(GROQ_STORAGE_KEYS);
  const apiKeys = normalizeGroqApiKeys(stored.groqApiKeys || stored.groqApiKey);
  state.groqSettings.apiKeys = apiKeys;
  state.groqSettings.apiKey = apiKeys[0] || "";
  state.groqSettings.model = stored.groqModel || GROQ_DEFAULT_MODEL;
  state.groqSettings.language = stored.groqLanguage || "auto";

  nodes.groqApiKeyInput.value = apiKeys.join("\n");
  nodes.groqModelInput.value = state.groqSettings.model;
  nodes.groqLanguageInput.value = state.groqSettings.language;
}

function normalizeGroqApiKeys(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[\n,]+/);
  const seen = new Set();
  const keys = [];
  for (const item of list) {
    const key = String(item || "").trim();
    if (!key || key.startsWith("#") || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

async function saveGroqSettings() {
  const apiKeys = normalizeGroqApiKeys(nodes.groqApiKeyInput.value);
  const model = nodes.groqModelInput.value.trim() || GROQ_DEFAULT_MODEL;
  const language = nodes.groqLanguageInput.value.trim() || "auto";

  await chrome.storage.local.set({
    groqApiKeys: apiKeys,
    groqApiKey: apiKeys[0] || "",
    groqModel: model,
    groqLanguage: language
  });

  state.groqSettings.apiKeys = apiKeys;
  state.groqSettings.apiKey = apiKeys[0] || "";
  state.groqSettings.model = model;
  state.groqSettings.language = language;
  showButtonFeedback(nodes.saveGroqSettingsButton, "已保存", "保存设置");
  setMessage(apiKeys.length > 1 ? `Groq 设置已保存（${apiKeys.length} 个 Key 轮换）。` : "Groq 设置已保存。");
}

function toggleGroqSettings() {
  const nextHidden = !nodes.groqSettings.hidden;
  nodes.groqSettings.hidden = nextHidden;
  setButtonLabel(nodes.toggleGroqSettingsButton, nextHidden ? "设置" : "收起");
}

async function transcribeWithGroq(progressNode) {
  await refreshActiveTab();
  const platform = getSupportedPlatform(state.tab?.url);
  if (!platform) {
    setMessage("当前页面不受支持。", true);
    return;
  }

  if (!state.groqSettings.apiKeys.length && !state.groqSettings.apiKey) {
    nodes.groqSettings.hidden = false;
    setButtonLabel(nodes.toggleGroqSettingsButton, "收起");
    setMessage("请先填写并保存 Groq API Key（支持一行一个多 Key 轮换）。", true);
    return;
  }

  setGroqProgress(progressNode, "正在获取音频地址…");
  nodes.transcribeButton.disabled = true;
  nodes.fallbackGroqButton.disabled = true;
  setMessage("正在获取音频地址…");

  try {
    const audioSource = await sendToContent(getAudioSourceMessageType(platform));
    if (!audioSource?.url) throw new Error("当前页面没有返回可用音频地址。");
    setGroqProgress(progressNode, "正在下载音频…");
    setMessage("正在下载音频…");
    const audioBlob = await fetchAudioBlob(audioSource.url, platform);
    setGroqProgress(progressNode, "正在切片并调用 Groq Whisper…");
    setMessage("正在切片并调用 Groq Whisper…");
    const sliceResults = await transcribeAudioSlices(audioBlob, { progressNode, platform });
    const result = normalizeGroqSlices(sliceResults, {
      platform,
      videoId: parsePlatformVideoId(state.tab?.url, platform) || state.metadata?.videoId || audioSource.videoId,
      url: state.tab?.url || state.metadata?.url,
      title: state.metadata?.title || cleanPlatformTitle(state.tab?.title || "", platform),
      author: state.metadata?.author || "",
      language: state.groqSettings.language
    });
    state.metadata = state.metadata || {
      platform,
      videoId: result.videoId,
      url: result.url,
      title: result.title,
      author: result.author
    };
    state.tracks = [];
    state.result = result;
    state.activeResult = result;
    renderResult(result);
    await saveResultCache();
    setGroqProgress(progressNode, "");
    setMessage(`Groq 转录完成，已提取 ${result.segments.length} 段。`);
  } catch (error) {
    setGroqProgress(progressNode, "");
    setMessage(error.message, true);
  } finally {
    nodes.transcribeButton.disabled = false;
    nodes.fallbackGroqButton.disabled = false;
  }
}

function setGroqProgress(progressNode, text) {
  if (!progressNode) return;
  progressNode.hidden = !text;
  progressNode.textContent = text || "";
}

function getAudioSourceMessageType(platform) {
  const type = PLATFORM_CONFIG[platform]?.messageTypes?.getAudioSource;
  if (!type) throw new Error("当前页面平台不支持音频获取。");
  return type;
}

async function fetchAudioBlob(audioUrl, platform) {
  const response = await fetch(audioUrl, {
    credentials: platform === "bilibili" ? "include" : "omit",
    referrer: state.tab?.url || location.href
  });
  if (!response.ok) {
    throw new Error(`音频下载失败：HTTP ${response.status}`);
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error("音频下载为空。");
  return blob;
}

function getGroqApiKeys() {
  const keys = normalizeGroqApiKeys(state.groqSettings.apiKeys);
  if (state.groqSettings.apiKey && !keys.includes(state.groqSettings.apiKey)) {
    keys.unshift(state.groqSettings.apiKey);
  }
  return keys;
}

function parseRateLimitWaitSeconds(message) {
  const text = String(message || "");
  const minuteMatch = text.match(/try again in ([0-9]+)m([0-9]+(?:\.[0-9]+)?)s/i);
  if (minuteMatch) return Number(minuteMatch[1]) * 60 + Number(minuteMatch[2]) + 1;
  const secondMatch = text.match(/try again in ([0-9]+(?:\.[0-9]+)?)s/i);
  if (secondMatch) return Number(secondMatch[1]) + 1;
  return 0;
}

async function sliceAudioBlob(audioBlob) {
  const durationSeconds = await probeAudioDuration(audioBlob);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return { slices: [{ blob: audioBlob, start: 0, end: null, index: 1 }], durationSeconds: null };
  }
  if (durationSeconds <= GROQ_SLICE_SECONDS && audioBlob.size <= GROQ_SLICE_MAX_BYTES) {
    return { slices: [{ blob: audioBlob, start: 0, end: durationSeconds, index: 1 }], durationSeconds };
  }
  // No ffmpeg in the extension: decode once via WebAudio, then re-encode each
  // window as 16kHz mono WAV. This mirrors Panopto's chunk/overlap/manifest
  // idea (split_for_groq.py) using only browser capabilities.
  const channelData = await decodeAudioToMono16k(audioBlob);
  const sampleRate = 16000;
  const stride = GROQ_SLICE_SECONDS - GROQ_SLICE_OVERLAP_SECONDS;
  const slices = [];
  let start = 0;
  let index = 1;
  while (start < durationSeconds) {
    const end = Math.min(start + GROQ_SLICE_SECONDS, durationSeconds);
    const startSample = Math.floor(start * sampleRate);
    const endSample = Math.min(channelData.length, Math.ceil(end * sampleRate));
    const window = channelData.slice(startSample, endSample);
    slices.push({
      blob: encodeWavBlob(window, sampleRate),
      start,
      end,
      index
    });
    if (end >= durationSeconds) break;
    start += stride;
    index += 1;
  }
  return { slices, durationSeconds };
}

async function decodeAudioToMono16k(audioBlob) {
  const OfflineAudioContextCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!OfflineAudioContextCtor && !AudioContextCtor) {
    throw new Error("当前浏览器不支持音频解码切片，长音频请用 D:/PanoptoTranscribe/transcribe.py 处理。");
  }
  const sourceBuffer = await audioBlob.arrayBuffer();
  let decoded;
  try {
    if (OfflineAudioContextCtor) {
      const ctx = new OfflineAudioContextCtor(1, 16000, 16000);
      decoded = await ctx.decodeAudioData(sourceBuffer.slice(0));
    } else {
      const ctx = new AudioContextCtor();
      try {
        decoded = await ctx.decodeAudioData(sourceBuffer.slice(0));
      } finally {
        try {
          await ctx.close();
        } catch (_error) {
          // Ignore close races.
        }
      }
    }
  } catch (_error) {
    throw new Error("音频解码失败，长音频请用 D:/PanoptoTranscribe/transcribe.py 处理。");
  }
  const channelCount = decoded.numberOfChannels || 1;
  const length = decoded.length || 0;
  if (!length) throw new Error("音频解码为空。");
  const mono = new Float32Array(length);
  for (let channel = 0; channel < channelCount; channel += 1) {
    const data = decoded.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      mono[i] += data[i] / channelCount;
    }
  }
  const sourceRate = decoded.sampleRate || 16000;
  if (sourceRate === 16000) return mono;
  const targetLength = Math.floor((length * 16000) / sourceRate);
  const resampled = new Float32Array(targetLength);
  for (let i = 0; i < targetLength; i += 1) {
    const pos = (i * sourceRate) / 16000;
    const left = Math.floor(pos);
    const frac = pos - left;
    const a = mono[left] || 0;
    const b = mono[left + 1] || a;
    resampled[i] = a + (b - a) * frac;
  }
  return resampled;
}

function encodeWavBlob(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 32768 : clamped * 32767, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function probeAudioDuration(audioBlob) {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(audioBlob);
      const audio = new Audio();
      audio.preload = "metadata";
      const done = (value) => {
        try {
          URL.revokeObjectURL(url);
        } catch (_error) {
          // Ignore cleanup races.
        }
        resolve(value);
      };
      audio.onloadedmetadata = () => done(Number(audio.duration));
      audio.onerror = () => done(Number.NaN);
      audio.src = url;
      window.setTimeout(() => done(Number.NaN), 8000);
    } catch (_error) {
      resolve(Number.NaN);
    }
  });
}

async function transcribeAudioSlices(audioBlob, { progressNode, platform }) {
  const apiKeys = getGroqApiKeys();
  if (!apiKeys.length) throw new Error("请先填写并保存 Groq API Key。");
  const cooldowns = apiKeys.map(() => 0);
  const { slices, durationSeconds } = await sliceAudioBlob(audioBlob);
  const total = slices.length;
  const sliceResults = [];

  // Small files / unknown duration: single Groq call, keys rotate on 429.
  if (total <= 1 || !Number.isFinite(durationSeconds)) {
    const only = slices[0];
    const raw = await transcribeOneSliceWithRotation(only.blob, apiKeys, cooldowns, 1, 1, progressNode);
    sliceResults.push({ ...only, raw });
    return sliceResults;
  }

  // Long audio: each slice window is a real WAV re-encode, uploaded separately.
  // Time offsets + overlap-drop mirror D:/PanoptoTranscribe/transcribe_groq_chunks.py.
  for (let i = 0; i < slices.length; i += 1) {
    const slice = slices[i];
    if (slice.blob.size > GROQ_SLICE_MAX_BYTES) {
      throw new Error(`第 ${slice.index} 个音频分片过大（${(slice.blob.size / 1048576).toFixed(1)}MB），请用 D:/PanoptoTranscribe/transcribe.py 处理。`);
    }
    setGroqProgress(progressNode, `正在转录 ${i + 1}/${total}…`);
    setMessage(`正在转录 ${i + 1}/${total}…`);
    const raw = await transcribeOneSliceWithRotation(slice.blob, apiKeys, cooldowns, i + 1, total, progressNode);
    sliceResults.push({ ...slice, raw });
  }
  return sliceResults;
}

async function transcribeOneSliceWithRotation(sliceBlob, apiKeys, cooldowns, sliceIndex, sliceTotal, progressNode) {
  if (sliceBlob.size > GROQ_SLICE_MAX_BYTES) {
    throw new Error("音频分片过大，请用 D:/PanoptoTranscribe/transcribe.py 处理。");
  }
  while (true) {
    const now = Date.now();
    const available = cooldowns
      .map((until, index) => ({ until, index }))
      .filter((entry) => entry.until <= now)
      .map((entry) => entry.index);
    if (!available.length) {
      const waitMs = Math.max(1000, Math.min(...cooldowns) - now);
      setGroqProgress(progressNode, `Key 限流，等待 ${(waitMs / 1000).toFixed(1)}s 后继续（${sliceIndex}/${sliceTotal}）…`);
      await new Promise((resolve) => window.setTimeout(resolve, waitMs));
      continue;
    }
    for (const keyIndex of available) {
      try {
        return await requestGroqTranscription(sliceBlob, apiKeys[keyIndex]);
      } catch (error) {
        const status = error?.groqStatus;
        const waitSeconds = parseRateLimitWaitSeconds(error?.message);
        if (status === 429 || /rate limit|too many requests|please try again/i.test(error?.message || "")) {
          cooldowns[keyIndex] = Date.now() + (waitSeconds > 0 ? waitSeconds * 1000 : 60000);
          setGroqProgress(progressNode, `Key ${keyIndex + 1} 限流，已切换 Key（${sliceIndex}/${sliceTotal}）…`);
          setMessage(`Key ${keyIndex + 1} 限流，已切换 Key（${sliceIndex}/${sliceTotal}）…`);
          break;
        }
        throw error;
      }
    }
  }
}

async function requestGroqTranscription(audioBlob, apiKey) {
  const key = apiKey || state.groqSettings.apiKey || getGroqApiKeys()[0];
  if (!key) throw new Error("请先填写并保存 Groq API Key。");
  const formData = new FormData();
  formData.append("file", audioBlob, guessAudioFilename(audioBlob.type));
  formData.append("model", state.groqSettings.model || GROQ_DEFAULT_MODEL);
  formData.append("response_format", "verbose_json");
  const language = normalizeLanguage(state.groqSettings.language);
  if (language && language !== "auto") {
    formData.append("language", language);
  }

  const response = await fetch(GROQ_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`
    },
    body: formData
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `Groq API HTTP ${response.status}`;
    const error = new Error(message);
    error.groqStatus = response.status;
    throw error;
  }
  return data;
}

function guessAudioFilename(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("webm")) return "audio.webm";
  if (normalized.includes("ogg")) return "audio.ogg";
  if (normalized.includes("wav")) return "audio.wav";
  return "audio.m4a";
}

function normalizeGroqSlices(sliceResults, context) {
  const segments = [];
  for (const slice of sliceResults) {
    const rawSegments = Array.isArray(slice.raw?.segments) ? slice.raw.segments : [];
    for (const segment of rawSegments) {
      const localStart = Number(segment.start);
      const localEnd = Number(segment.end);
      const text = String(segment.text || "").trim();
      if (!Number.isFinite(localStart) || !text) continue;
      // Mirror Panopto overlap stitching: drop head-overlap duplicates.
      if (slice.index > 1 && Number.isFinite(localEnd) && localEnd <= GROQ_SLICE_OVERLAP_SECONDS) continue;
      const sliceStart = Number.isFinite(slice.start) ? slice.start : 0;
      const absoluteStart = localStart + sliceStart;
      const absoluteEnd = Number.isFinite(localEnd) ? localEnd + sliceStart : undefined;
      segments.push({
        startSeconds: absoluteStart,
        durationSeconds: Number.isFinite(absoluteStart) && Number.isFinite(absoluteEnd) && absoluteEnd > absoluteStart
          ? absoluteEnd - absoluteStart
          : undefined,
        text,
        sliceIndex: slice.index
      });
    }
  }

  segments.sort((a, b) => a.startSeconds - b.startSeconds);
  const deduped = [];
  for (const segment of segments) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.text === segment.text && Math.abs(prev.startSeconds - segment.startSeconds) < 1) continue;
    deduped.push(segment);
  }

  if (!deduped.length) {
    throw new Error("Groq 返回了空转录结果。");
  }

  return {
    platform: context.platform,
    videoId: context.videoId,
    url: context.url,
    title: context.title || "未命名视频",
    author: context.author || "",
    selectedTrack: {
      id: "groq-whisper",
      platform: context.platform,
      language: normalizeLanguage(context.language) || state.groqSettings.language || "auto",
      label: "Groq Whisper",
      source: "asr"
    },
    availableTracks: [],
    segments: deduped.map(({ startSeconds, durationSeconds, text }) => ({ startSeconds, durationSeconds, text })),
    text: deduped.map((segment) => segment.text).join("\n"),
    warnings: sliceResults.length > 1 ? ["长音频已按 300s/5s 重叠切片转录后拼接。"] : []
  };
}

function normalizeGroqResult(groqJson, context) {
  return normalizeGroqSlices([{ raw: groqJson, index: 1, start: 0 }], context);
}

async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab || state.tab;
}

function renderTracks() {
  nodes.trackSelect.innerHTML = "";

  if (!state.tracks.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "没有可用字幕";
    nodes.trackSelect.appendChild(option);
    nodes.trackSelect.disabled = true;
    nodes.switchTrackButton.disabled = true;
    return;
  }

  for (const track of state.tracks) {
    const option = document.createElement("option");
    option.value = track.id;
    option.textContent = `${track.label || track.language} (${track.language})`;
    nodes.trackSelect.appendChild(option);
  }

  nodes.trackSelect.disabled = false;
  nodes.switchTrackButton.disabled = false;
}

function renderResult(result) {
  nodes.statusCard.hidden = true;
  nodes.noSubtitlePanel.hidden = true;
  nodes.extractFailedPanel.hidden = true;
  nodes.resultPanel.hidden = false;
  state.activeResult = result;
  renderCollectionList(result);
  renderActiveResult();
}

function renderActiveResult() {
  const result = getActiveResult();
  if (!result) return;

  nodes.segmentCount.textContent = String(result.segments?.length || 0);
  nodes.selectedLanguage.textContent = result.kind === "collection"
    ? `${result.selectedTrack.label || result.selectedTrack.language} · ${result.items?.length || 0} 个视频`
    : result.selectedTrack.label || result.selectedTrack.language;
  nodes.preview.textContent = formatPreview(result);
  updateCollectionSelection();
}

async function restoreCachedResult(platform, videoId) {
  const cache = await readResultCache();
  if (!isUsableResultCache(cache, platform, videoId)) return false;

  state.metadata = cache.metadata || null;
  state.tracks = cache.tracks || cache.result?.availableTracks || [];
  state.result = cache.result;
  state.activeResult = cache.result;

  if (state.metadata) {
    nodes.videoId.textContent = state.metadata.videoId || videoId || "-";
    nodes.videoTitle.textContent = state.metadata.title || state.result.title || nodes.videoTitle.textContent;
    nodes.videoAuthor.textContent = state.metadata.author ? `${getPlatformAuthorLabel(state.metadata.platform)}：${state.metadata.author}` : "";
  } else if (state.result) {
    nodes.videoId.textContent = state.result.videoId || videoId || "-";
    nodes.videoTitle.textContent = state.result.title || nodes.videoTitle.textContent;
    nodes.videoAuthor.textContent = state.result.author ? `${getPlatformAuthorLabel(state.result.platform)}：${state.result.author}` : "";
  }

  renderTracks();
  if (state.tracks.length && cache.selectedTrackId && state.tracks.some((track) => track.id === cache.selectedTrackId)) {
    nodes.trackSelect.value = cache.selectedTrackId;
  } else if (state.result?.selectedTrack?.id === "groq-whisper") {
    nodes.trackSelect.innerHTML = "";
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Groq Whisper 转录";
    nodes.trackSelect.appendChild(option);
    nodes.trackSelect.disabled = true;
    nodes.switchTrackButton.disabled = true;
  }
  renderResult(state.result);
  state.activeResult = state.result;
  renderActiveResult();
  setMessage(`已恢复上次提取结果：${formatCacheAge(cache.savedAt)}。`);
  return true;
}

function isUsableResultCache(cache, platform, videoId) {
  if (!cache || cache.version !== RESULT_CACHE_VERSION || !cache.result) return false;
  if (cache.platform !== platform) return false;
  if (cache.videoId && videoId && cache.videoId !== videoId && !doesCollectionContainVideo(cache.result, videoId)) return false;
  return Date.now() - Number(cache.savedAt || 0) < 7 * 24 * 60 * 60 * 1000;
}

function doesCollectionContainVideo(result, videoId) {
  return isCollectionResult(result) && result.items.some((item) => item.videoId === videoId || item.bvid === videoId);
}

async function saveResultCache() {
  if (!state.result) return false;

  const platform = state.result.platform || state.metadata?.platform || getSupportedPlatform(state.tab?.url);
  const videoId = parsePlatformVideoId(state.tab?.url, platform) || state.metadata?.videoId || state.result.videoId;
  const selectedTrackId = state.result.selectedTrack?.id === "groq-whisper"
    ? "groq-whisper"
    : nodes.trackSelect.value;
  const cache = {
    version: RESULT_CACHE_VERSION,
    savedAt: Date.now(),
    platform,
    videoId,
    selectedTrackId,
    metadata: state.metadata,
    tracks: state.tracks,
    collection: state.collection,
    result: state.result
  };

  try {
    await writeResultCache(cache);
    return true;
  } catch (error) {
    setMessage(`结果已提取，但缓存保存失败：${error.message}`, true);
    return false;
  }
}

async function readResultCache() {
  const stored = await chrome.storage.local.get([RESULT_CACHE_KEY]);
  const manifest = stored[RESULT_CACHE_KEY];
  if (!manifest) return null;

  if (!manifest.chunked) return manifest;
  if (!manifest.chunkCount) return null;

  const keys = Array.from({ length: manifest.chunkCount }, (_item, index) => getResultCacheChunkKey(manifest.cacheId, index));
  const chunks = await chrome.storage.local.get(keys);
  const text = keys.map((key) => chunks[key] || "").join("");
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

async function writeResultCache(cache) {
  const text = JSON.stringify(cache);
  const chunks = splitText(text, RESULT_CACHE_CHUNK_SIZE);
  const previousManifest = (await chrome.storage.local.get([RESULT_CACHE_KEY]))[RESULT_CACHE_KEY];
  const cacheId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;

  const payload = {
    [RESULT_CACHE_KEY]: {
      version: cache.version,
      savedAt: cache.savedAt,
      platform: cache.platform,
      videoId: cache.videoId,
      chunked: true,
      cacheId,
      chunkCount: chunks.length,
      byteLength: text.length
    }
  };
  chunks.forEach((chunk, index) => {
    payload[getResultCacheChunkKey(cacheId, index)] = chunk;
  });

  await chrome.storage.local.set(payload);
  await removePreviousResultCacheChunks(previousManifest);
}

function splitText(text, chunkSize) {
  const chunks = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }
  return chunks.length ? chunks : [""];
}

async function removePreviousResultCacheChunks(previousManifest) {
  if (!previousManifest?.chunkCount) return;

  const keysToRemove = [];
  for (let index = 0; index < previousManifest.chunkCount; index += 1) {
    keysToRemove.push(getResultCacheChunkKey(previousManifest.cacheId, index));
    if (!previousManifest.cacheId) keysToRemove.push(`${RESULT_CACHE_CHUNK_PREFIX}_${index}`);
  }
  await chrome.storage.local.remove(keysToRemove);
}

function getResultCacheChunkKey(cacheId, index) {
  return cacheId ? `${RESULT_CACHE_CHUNK_PREFIX}_${cacheId}_${index}` : `${RESULT_CACHE_CHUNK_PREFIX}_${index}`;
}

function renderCollectionList(result) {
  nodes.collectionList.innerHTML = "";
  if (!isCollectionResult(result)) {
    nodes.collectionPanel.hidden = true;
    return;
  }

  nodes.collectionPanel.hidden = false;
  nodes.collectionCount.textContent = `${result.items.length}/${result.collection?.totalCount || result.items.length}`;
  nodes.collectionList.appendChild(createCollectionButton("collection", "合集总览", result.segments.length));

  for (const item of result.items) {
    nodes.collectionList.appendChild(createCollectionButton(String(item.collectionIndex), `${item.collectionIndex}. ${item.title}`, item.segments.length));
  }
}

function createCollectionButton(targetId, label, segmentCount) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "collection-item";
  button.dataset.targetId = targetId;
  button.innerHTML = `${BUTTON_ICON_HTML.extractCollectionButton}<span class="button-label"></span>`;
  button.querySelector(".button-label").textContent = `${label} · ${segmentCount} 段`;
  button.addEventListener("click", () => selectCollectionTarget(targetId));
  return button;
}

function selectCollectionTarget(targetId) {
  if (!isCollectionResult(state.result)) return;

  state.activeResult = targetId === "collection"
    ? state.result
    : state.result.items.find((item) => String(item.collectionIndex) === targetId) || state.result;
  renderActiveResult();
  setMessage(targetId === "collection" ? "已切换到合集总览。" : "已切换到单个视频。");
}

function updateCollectionSelection() {
  const activeId = isCollectionResult(state.activeResult) ? "collection" : String(state.activeResult?.collectionIndex || "");
  for (const button of nodes.collectionList.querySelectorAll(".collection-item")) {
    button.classList.toggle("active", button.dataset.targetId === activeId);
  }
}

function sendToContent(type, payload = {}) {
  return sendMessageToTab(type, payload).catch(async (error) => {
    if (!/Receiving end does not exist|Could not establish connection/i.test(error.message)) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId: state.tab.id },
      files: ["content/content.js"]
    });

    return sendMessageToTab(type, payload);
  });
}

function getMessageType(action) {
  const platform = state.metadata?.platform || getSupportedPlatform(state.tab?.url);
  const type = PLATFORM_CONFIG[platform]?.messageTypes?.[action];
  if (!type) throw new Error("当前页面平台不支持该操作。");
  return type;
}

function sendMessageToTab(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(state.tab.id, { type, payload }, (response) => {
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

function getActiveResult() {
  return state.activeResult || state.result;
}

function buildMarkdown(result) {
  if (isCollectionResult(result)) return buildCollectionMarkdown(result);

  const lines = [
    "---",
    `platform: ${escapeYaml(result.platform || "unknown")}`,
    `video_id: ${escapeYaml(result.videoId)}`,
    `source: ${escapeYaml(result.url)}`,
    `subtitle_language: ${escapeYaml(result.selectedTrack.language)}`,
    "---",
    "",
    `# ${result.title}`,
    "",
    "## Transcript",
    ""
  ];

  for (const segment of result.segments) {
    lines.push(`[${formatTime(segment.startSeconds)}] ${segment.text}`);
  }

  return `${lines.join("\n")}\n`;
}

function buildCollectionMarkdown(result) {
  const lines = [
    "---",
    `platform: ${escapeYaml(result.platform || "unknown")}`,
    `kind: ${escapeYaml("collection")}`,
    `source: ${escapeYaml(result.url)}`,
    `collection_title: ${escapeYaml(result.collection?.title || result.title)}`,
    `subtitle_language: ${escapeYaml(result.selectedTrack.language)}`,
    `video_count: ${result.items?.length || 0}`,
    "---",
    "",
    `# ${result.title}`,
    ""
  ];

  for (const item of result.items || []) {
    lines.push(`## ${item.collectionIndex}. ${item.title}`);
    lines.push("");
    lines.push(`- BV: ${item.videoId}`);
    lines.push(`- URL: ${item.url}`);
    lines.push("");

    for (const segment of item.segments) {
      lines.push(`[${formatTime(segment.startSeconds)}] ${segment.text}`);
    }

    lines.push("");
  }

  if (result.warnings?.length) {
    lines.push("## Warnings");
    lines.push("");
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function buildPlainText(result) {
  if (isCollectionResult(result)) {
    return `${(result.items || []).map((item) => [
      `${item.collectionIndex}. ${item.title}`,
      item.text
    ].join("\n")).join("\n\n")}\n`;
  }

  return `${result.segments.map((segment) => segment.text).join("\n")}\n`;
}

function buildSrt(result) {
  if (isCollectionResult(result)) return buildCollectionSrt(result);

  return `${buildSrtBlocks(result.segments)}\n`;
}

function buildCollectionSrt(result) {
  let subtitleIndex = 1;
  const blocks = [];

  for (const item of result.items || []) {
    blocks.push(`NOTE ${item.collectionIndex}. ${item.title}`);
    for (let index = 0; index < item.segments.length; index += 1) {
      const segment = item.segments[index];
      const startSeconds = Number(segment.startSeconds) || 0;
      const endSeconds = resolveSegmentEndSeconds(segment, item.segments[index + 1]);
      blocks.push([
        String(subtitleIndex),
        `${formatSrtTime(startSeconds)} --> ${formatSrtTime(endSeconds)}`,
        sanitizeSrtText(segment.text)
      ].join("\n"));
      subtitleIndex += 1;
    }
  }

  return `${blocks.join("\n\n")}\n`;
}

function buildSrtBlocks(segments, startIndex = 1) {
  const blocks = segments.map((segment, index, allSegments) => {
    const startSeconds = Number(segment.startSeconds) || 0;
    const endSeconds = resolveSegmentEndSeconds(segment, allSegments[index + 1]);

    return [
      String(startIndex + index),
      `${formatSrtTime(startSeconds)} --> ${formatSrtTime(endSeconds)}`,
      sanitizeSrtText(segment.text)
    ].join("\n");
  });

  return blocks.join("\n\n");
}

function resolveSegmentEndSeconds(segment, nextSegment) {
  const startSeconds = Number(segment.startSeconds) || 0;
  const endSeconds = Number(segment.endSeconds);
  if (Number.isFinite(endSeconds) && endSeconds > startSeconds) {
    return endSeconds;
  }

  const durationSeconds = Number(segment.durationSeconds);
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    return startSeconds + durationSeconds;
  }

  const nextStartSeconds = Number(nextSegment?.startSeconds);
  if (Number.isFinite(nextStartSeconds) && nextStartSeconds > startSeconds) {
    return nextStartSeconds;
  }

  return startSeconds + 2;
}

function sanitizeSrtText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function copyPlainText() {
  const result = getActiveResult();
  if (!result) return;

  await navigator.clipboard.writeText(result.text);
  showButtonFeedback(nodes.copyTextButton, "已复制", "复制全文");
  setMessage("全文已复制。");
}

function downloadText(type) {
  const result = getActiveResult();
  if (!result) return;

  const format = EXPORT_FORMATS[type] || EXPORT_FORMATS.txt;
  const text = format.build(result);
  const filename = `${safeFilename(result.title || result.videoId)}.${format.extension}`;
  const url = URL.createObjectURL(new Blob([text], { type: `${format.mime};charset=utf-8` }));

  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

function setButtonLabel(button, label) {
  const labelNode = button.querySelector(".button-label");
  if (labelNode) {
    labelNode.textContent = label;
    return;
  }

  button.innerHTML = `${BUTTON_ICON_HTML[button.id] || ""}<span class="button-label"></span>`;
  button.querySelector(".button-label").textContent = label;
}

function showButtonFeedback(button, feedbackLabel, restoreLabel) {
  setButtonLabel(button, feedbackLabel);
  button.classList.add("copied");
  window.setTimeout(() => {
    button.classList.remove("copied");
    setButtonLabel(button, restoreLabel);
  }, 1300);
}

function setStatus(text, variant) {
  nodes.pageStatus.textContent = text;
  nodes.pageStatus.classList.remove("ok", "error");
  if (variant) nodes.pageStatus.classList.add(variant);
}

function setMessage(text, isError = false) {
  nodes.message.textContent = text;
  nodes.message.classList.toggle("error", isError);
}

function getSupportedPlatform(url) {
  for (const [platform, config] of Object.entries(PLATFORM_CONFIG)) {
    if (config.isVideoUrl(url)) return platform;
  }
  return "";
}

function isBilibiliVideoUrl(url) {
  return /^https:\/\/www\.bilibili\.com\/video\/BV/i.test(url || "");
}

function isYouTubeVideoUrl(url) {
  try {
    const parsed = new URL(url || "");
    const hostname = parsed.hostname;
    if (hostname !== "www.youtube.com" && hostname !== "m.youtube.com") return false;
    return (parsed.pathname === "/watch" && parsed.searchParams.has("v")) || /^\/shorts\/[^/]+/.test(parsed.pathname);
  } catch (_error) {
    return false;
  }
}

function parsePlatformVideoId(url, platform) {
  return PLATFORM_CONFIG[platform]?.parseVideoId(url) || "";
}

function parseBilibiliVideoId(url) {
  return (url || "").match(/\/video\/(BV[a-zA-Z0-9]+)/i)?.[1] || "";
}

function parseYouTubeVideoId(url) {
  try {
    const parsed = new URL(url || "");
    if (parsed.pathname.startsWith("/shorts/")) return parsed.pathname.split("/")[2] || "";
    return parsed.searchParams.get("v") || "";
  } catch (_error) {
    return "";
  }
}

function cleanPlatformTitle(title, platform = getSupportedPlatform(state.tab?.url)) {
  return PLATFORM_CONFIG[platform]?.cleanTitle(title) || String(title || "").trim();
}

function cleanBilibiliTitle(title) {
  return title.replace(/_哔哩哔哩_bilibili$/, "").trim();
}

function cleanYouTubeTitle(title) {
  return title.replace(/ - YouTube$/, "").trim();
}

function getPlatformLabel(platform) {
  return PLATFORM_CONFIG[platform]?.label || "当前平台";
}

function getPlatformAuthorLabel(platform) {
  return PLATFORM_CONFIG[platform]?.authorLabel || "作者";
}

function formatSegment(segment) {
  return `[${formatTime(segment.startSeconds)}] ${segment.text}`;
}

function formatPreview(result) {
  if (!isCollectionResult(result)) {
    return result.segments.slice(0, 80).map(formatSegment).join("\n");
  }

  const lines = [];
  for (const item of result.items || []) {
    lines.push(`## ${item.collectionIndex}. ${item.title}`);
    lines.push(...item.segments.slice(0, 12).map(formatSegment));
    lines.push("");
    if (lines.length > 90) break;
  }

  if (result.warnings?.length) {
    lines.push("Warnings:");
    lines.push(...result.warnings.slice(0, 6).map((warning) => `- ${warning}`));
  }

  return lines.join("\n").trim();
}

function isCollectionResult(result) {
  return result?.kind === "collection" && Array.isArray(result.items);
}

function buildJson(result) {
  return JSON.stringify(result, (key, value) => {
    if (!JSON_TIME_FIELDS.has(key) || !Number.isFinite(value)) return value;
    return Math.round((value + Number.EPSILON) * 1000) / 1000;
  }, 2);
}

function formatTime(totalSeconds) {
  const totalMilliseconds = Math.max(0, Math.round((Number(totalSeconds) || 0) * 1000));
  const milliseconds = totalMilliseconds % 1000;
  const totalWholeSeconds = Math.floor(totalMilliseconds / 1000);
  const hh = Math.floor(totalWholeSeconds / 3600);
  const mm = Math.floor((totalWholeSeconds % 3600) / 60);
  const ss = totalWholeSeconds % 60;
  const baseTime = hh > 0 ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;

  return `${baseTime}.${String(milliseconds).padStart(3, "0")}`;
}

function formatCacheAge(savedAt) {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Number(savedAt || 0)) / 1000));
  if (elapsedSeconds < 60) return "刚刚";
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} 小时前`;
  return `${Math.floor(elapsedHours / 24)} 天前`;
}

function formatSrtTime(totalSeconds) {
  const totalMilliseconds = Math.max(0, Math.round((Number(totalSeconds) || 0) * 1000));
  const milliseconds = totalMilliseconds % 1000;
  const totalWholeSeconds = Math.floor(totalMilliseconds / 1000);
  const hh = Math.floor(totalWholeSeconds / 3600);
  const mm = Math.floor((totalWholeSeconds % 3600) / 60);
  const ss = totalWholeSeconds % 60;

  return `${pad(hh)}:${pad(mm)}:${pad(ss)},${String(milliseconds).padStart(3, "0")}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function escapeYaml(value) {
  return JSON.stringify(String(value || ""));
}

function safeFilename(value) {
  return String(value || "chrono-subtitle")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "chrono-subtitle";
}
