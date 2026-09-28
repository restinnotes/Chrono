// Groq chunk pipeline in the service worker: multi-key rotation, 300s/5s
// overlap WAV slicing, and stitching. Keys arrive per-job from the popup and
// are never written to disk by this worker.
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_SLICE_SECONDS = 300;
const GROQ_SLICE_OVERLAP_SECONDS = 5;
const GROQ_SLICE_MAX_BYTES = 24 * 1024 * 1024;

async function fetchAudioBlob(audioSource, platform, tabUrl) {
  const urls = [...new Set([audioSource?.url, ...(audioSource?.backupUrls || [])].filter(Boolean))];
  if (!urls.length) throw new Error("当前页面没有返回可用音频地址。");

  let lastError;
  let lastHttpError;
  for (const audioUrl of urls) {
    try {
      const response = await fetch(audioUrl, {
        credentials: platform === "bilibili" ? "include" : "omit",
        referrer: buildAudioReferer(platform, tabUrl),
        referrerPolicy: "no-referrer-when-downgrade"
      });
      if (!response.ok) {
        const error = new Error(`音频下载失败：HTTP ${response.status}`);
        error.httpStatus = response.status;
        lastHttpError = error;
        lastError = error;
        continue;
      }
      const blob = await response.blob();
      if (!blob.size) {
        lastError = new Error("音频下载为空。");
        continue;
      }
      return blob;
    } catch (error) {
      if (!lastHttpError) lastError = error;
    }
  }

  if (lastHttpError) {
    lastHttpError.message += `（已尝试 ${urls.length} 个音频地址）`;
    throw lastHttpError;
  }
  throw lastError || new Error("音频下载失败。");
}

function buildAudioReferer(platform, tabUrl) {
  const url = new URL(tabUrl || "https://www.youtube.com/");
  const allowedParams = platform === "bilibili" ? ["p"] : ["v"];
  for (const key of [...url.searchParams.keys()]) {
    if (!allowedParams.includes(key)) url.searchParams.delete(key);
  }
  url.hash = "";
  return url.toString();
}

function normalizeLanguage(value) {
  return String(value || "").toLowerCase().replace(/_/g, "-").split("-")[0];
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

function parseRateLimitWaitSeconds(message) {
  const text = String(message || "");
  const minuteMatch = text.match(/try again in ([0-9]+)m([0-9]+(?:\.[0-9]+)?)s/i);
  if (minuteMatch) return Number(minuteMatch[1]) * 60 + Number(minuteMatch[2]) + 1;
  const secondMatch = text.match(/try again in ([0-9]+(?:\.[0-9]+)?)s/i);
  if (secondMatch) return Number(secondMatch[1]) + 1;
  return 0;
}

async function transcribeAudioSlices(jobId, audioBlob, payload) {
  const apiKeys = normalizeGroqApiKeys(payload.apiKeys);
  if (!apiKeys.length) throw new Error("请先填写并保存 Groq API Key。");
  const cooldowns = apiKeys.map(() => 0);
  const { slices, durationSeconds } = await sliceAudioBlob(audioBlob);
  const total = slices.length;
  const sliceResults = [];
  await updateGroqJob(jobId, { sliceTotal: total, sliceIndex: 0 });

  if (total <= 1 || !Number.isFinite(durationSeconds)) {
    const only = slices[0];
    const raw = await transcribeOneSliceWithRotation(only.blob, apiKeys, cooldowns, jobId, 1, 1, payload);
    sliceResults.push({ ...only, raw });
    return sliceResults;
  }

  for (let i = 0; i < slices.length; i += 1) {
    const slice = slices[i];
    if (slice.blob.size > GROQ_SLICE_MAX_BYTES) {
      throw new Error(`第 ${slice.index} 个音频分片过大（${(slice.blob.size / 1048576).toFixed(1)}MB）。`);
    }
    await updateGroqJob(jobId, {
      progress: `正在转录 ${i + 1}/${total}…`,
      sliceIndex: i,
      sliceTotal: total
    });
    const raw = await transcribeOneSliceWithRotation(slice.blob, apiKeys, cooldowns, jobId, i + 1, total, payload);
    sliceResults.push({ ...slice, raw });
    await updateGroqJob(jobId, { sliceIndex: i + 1, sliceTotal: total });
  }
  return sliceResults;
}

async function transcribeOneSliceWithRotation(sliceBlob, apiKeys, cooldowns, jobId, sliceIndex, sliceTotal, payload) {
  if (sliceBlob.size > GROQ_SLICE_MAX_BYTES) throw new Error("音频分片过大。");
  while (true) {
    const now = Date.now();
    const available = cooldowns
      .map((until, index) => ({ until, index }))
      .filter((entry) => entry.until <= now)
      .map((entry) => entry.index);
    if (!available.length) {
      const waitMs = Math.max(1000, Math.min(...cooldowns) - now);
      await updateGroqJob(jobId, {
        progress: `Key 限流，等待 ${(waitMs / 1000).toFixed(1)}s 后继续（${sliceIndex}/${sliceTotal}）…`
      });
      await sleep(waitMs);
      continue;
    }
    for (const keyIndex of available) {
      try {
        return await requestGroqTranscription(sliceBlob, apiKeys[keyIndex], payload);
      } catch (error) {
        const status = error?.groqStatus;
        const waitSeconds = parseRateLimitWaitSeconds(error?.message);
        if (status === 429 || /rate limit|too many requests|please try again/i.test(error?.message || "")) {
          cooldowns[keyIndex] = Date.now() + (waitSeconds > 0 ? waitSeconds * 1000 : 60000);
          await updateGroqJob(jobId, {
            progress: `Key ${keyIndex + 1} 限流，已切换 Key（${sliceIndex}/${sliceTotal}）…`
          });
          break;
        }
        throw error;
      }
    }
  }
}

async function requestGroqTranscription(audioBlob, apiKey, payload) {
  if (!apiKey) throw new Error("请先填写并保存 Groq API Key。");
  const formData = new FormData();
  formData.append("file", audioBlob, guessAudioFilename(audioBlob.type));
  formData.append("model", payload.model || GROQ_DEFAULT_MODEL);
  formData.append("response_format", "verbose_json");
  const language = normalizeLanguage(payload.language);
  if (language && language !== "auto") formData.append("language", language);

  const response = await fetch(GROQ_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
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

async function sliceAudioBlob(audioBlob) {
  const durationSeconds = await probeAudioDuration(audioBlob);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return { slices: [{ blob: audioBlob, start: 0, end: null, index: 1 }], durationSeconds: null };
  }
  if (durationSeconds <= GROQ_SLICE_SECONDS && audioBlob.size <= GROQ_SLICE_MAX_BYTES) {
    return { slices: [{ blob: audioBlob, start: 0, end: durationSeconds, index: 1 }], durationSeconds };
  }
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
    slices.push({
      blob: encodeWavBlob(channelData.slice(startSample, endSample), sampleRate),
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

function probeAudioDuration(audioBlob) {
  // Service workers have no <audio> element; decode a small header instead.
  // Fall back to single-upload when duration cannot be determined cheaply.
  return decodeAudioDuration(audioBlob);
}

async function decodeAudioDuration(audioBlob) {
  try {
    const head = new DataView(await audioBlob.slice(0, 65536).arrayBuffer());
    const riff = String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3));
    if (riff === "RIFF" && audioBlob.type.includes("wav")) {
      const sampleRate = head.getUint32(24, true);
      const dataBytes = audioBlob.size - 44;
      if (sampleRate > 0) return dataBytes / (sampleRate * 2);
    }
  } catch (_error) {
    // Fall through to unknown duration.
  }
  // WebM/MP4 duration parsing without a demuxer is unreliable; let the single
  // upload path handle small files, and decode-slice in the offscreen document
  // for large ones (below).
  if (audioBlob.size <= GROQ_SLICE_MAX_BYTES) return Number.NaN;
  return GROQ_SLICE_SECONDS + 1;
}

async function decodeAudioToMono16k(audioBlob) {
  // Service workers cannot use AudioContext; decode in the offscreen document.
  const offscreen = await ensureOffscreen();
  if (!offscreen) throw new Error("长音频需要页面解码，请保持视频页打开并重试。");
  const buffer = await audioBlob.arrayBuffer();
  const result = await sendToOffscreen({
    type: "CHRONO_DECODE_AUDIO",
    payload: { audio: Array.from(new Uint8Array(buffer)), mimeType: audioBlob.type }
  });
  if (!result?.samples?.length) throw new Error("音频解码失败。");
  return Float32Array.from(result.samples);
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

function normalizeGroqSlices(sliceResults, context) {
  const overlap = GROQ_SLICE_OVERLAP_SECONDS;
  const segments = [];
  for (const slice of sliceResults) {
    const rawSegments = Array.isArray(slice.raw?.segments) ? slice.raw.segments : [];
    for (const segment of rawSegments) {
      const localStart = Number(segment.start);
      const localEnd = Number(segment.end);
      const text = String(segment.text || "").trim();
      if (!Number.isFinite(localStart) || !text) continue;
      if (slice.index > 1 && Number.isFinite(localEnd) && localEnd <= overlap) continue;
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
  if (!deduped.length) throw new Error("Groq 返回了空转录结果。");

  return {
    platform: context.platform,
    videoId: context.videoId,
    url: context.url,
    title: context.title || "未命名视频",
    author: context.author || "",
    selectedTrack: {
      id: "groq-whisper",
      platform: context.platform,
      language: normalizeLanguage(context.language) || "auto",
      label: "Groq Whisper",
      source: "asr"
    },
    availableTracks: [],
    segments: deduped.map(({ startSeconds, durationSeconds, text }) => ({ startSeconds, durationSeconds, text })),
    text: deduped.map((segment) => segment.text).join("\n"),
    warnings: sliceResults.length > 1 ? ["长音频已按 300s/5s 重叠切片转录后拼接。"] : []
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL("offscreen/offscreen.html")]
    });
    if (contexts?.length) return true;
  } catch (_error) {
    // getContexts may be unavailable; fall through to createDocument.
  }
  try {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("offscreen/offscreen.html"),
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Decode long audio to 16kHz mono WAV slices for Groq transcription."
    });
    return true;
  } catch (error) {
    if (/already exists|Only a single/i.test(error?.message || "")) return true;
    return false;
  }
}

function sendToOffscreen(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ ...message, target: "CHRONO_OFFSCREEN" }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || "Offscreen document unreachable."));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Audio decode failed."));
        return;
      }
      resolve(response.data);
    });
  });
}
