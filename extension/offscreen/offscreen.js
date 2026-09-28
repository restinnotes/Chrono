// Offscreen document: only job is WebAudio decoding for long-audio slicing.
// The service worker cannot use AudioContext; the popup dies when closed.
// This document is created on demand and torn down after decoding.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "CHRONO_OFFSCREEN") return false;
  if (message.type === "CHRONO_DECODE_AUDIO") {
    decodeToMono16k(message.payload)
      .then((samples) => sendResponse({ ok: true, data: samples }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

async function decodeToMono16k({ audio, mimeType } = {}) {
  const bytes = Uint8Array.from(audio || []);
  if (!bytes.length) throw new Error("音频解码为空。");
  const blob = new Blob([bytes], { type: mimeType || "audio/mpeg" });
  const sourceBuffer = await blob.arrayBuffer();
  const OfflineAudioContextCtor = self.OfflineAudioContext || self.webkitOfflineAudioContext;
  const AudioContextCtor = self.AudioContext || self.webkitAudioContext;
  if (!OfflineAudioContextCtor && !AudioContextCtor) throw new Error("当前浏览器不支持音频解码。");

  let decoded;
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

  const channelCount = decoded.numberOfChannels || 1;
  const length = decoded.length || 0;
  if (!length) throw new Error("音频解码为空。");
  const mono = new Float32Array(length);
  for (let channel = 0; channel < channelCount; channel += 1) {
    const data = decoded.getChannelData(channel);
    for (let i = 0; i < length; i += 1) mono[i] += data[i] / channelCount;
  }
  const sourceRate = decoded.sampleRate || 16000;
  if (sourceRate === 16000) return { samples: Array.from(mono), sampleRate: 16000 };
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
  return { samples: Array.from(resampled), sampleRate: 16000 };
}
