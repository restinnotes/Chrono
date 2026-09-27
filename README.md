<img width="150" height="150" alt="icon" src="https://github.com/user-attachments/assets/469378f8-55b1-4ac8-a483-0c92bacfca85" /><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Cat icon">
  <rect x="0" y="0" width="128" height="128" fill="#ffffff"/>
  <path d="M24 47 20 13l29 22a56 56 0 0 1 30 0l29-22-4 34a52 52 0 1 1-80 0Z" fill="#f6bf62"/>
  <path d="M33 39 29 25l13 10" fill="#e87972"/>
  <path d="M95 39 99 25l-13 10" fill="#e87972"/>
  <ellipse cx="45" cy="65" rx="6" ry="8" fill="#111827"/>
  <ellipse cx="83" cy="65" rx="6" ry="8" fill="#111827"/>
  <path d="M64 76 57 70h14l-7 6Z" fill="#111827"/>
  <path d="M64 76v9" stroke="#111827" stroke-width="5" stroke-linecap="round"/>
  <path d="M53 89c6 6 16 6 22 0" fill="none" stroke="#111827" stroke-width="5" stroke-linecap="round"/>
  <path d="M28 76h22M28 88h22M78 76h22M78 88h22" stroke="#111827" stroke-width="5" stroke-linecap="round" opacity="0.72"/>
</svg>

# Chrono

Chrono 自动提取当前 Bilibili / YouTube 字幕。打开插件后自动选择最合适字幕，无需手动获取轨道或选择语言。无字幕的视频可以选择使用自己的 Groq API Key 调用 Whisper 转录。

## Features

- Detects the current Bilibili or YouTube video page.
- Automatically loads subtitle tracks when the popup opens.
- Automatically picks the best subtitle track (saved preference, browser language, manual before auto).
- Automatically extracts subtitles and shows the full transcript.
- One-click **复制全文** copies plain transcript text (`result.text`).
- Exports transcripts as TXT, SRT, MD, or JSON.
- Optional Groq Whisper fallback for videos without subtitle tracks (BYOK).
- Restores the last extracted result when reopening the popup on the same video page.

## Install Locally

Download the packaged extension from GitHub Releases, then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Extract the zip file.
5. Select the extracted `extension` directory.
6. Open a supported video page, for example `https://www.bilibili.com/video/BV...` or `https://www.youtube.com/watch?v=...`.
7. Click the Chrono extension icon.

## Usage

With subtitles:

1. Open a YouTube / Bilibili video page.
2. Click Chrono — subtitles are detected and extracted automatically.
3. Click **复制全文**. Optional: use TXT / SRT / MD / JSON exports.

Without subtitles:

1. Open the video page and click Chrono.
2. Click **使用 Groq 转录** (requires a Groq API Key in Groq settings).
3. After transcription finishes, click **复制全文**.

Advanced users can switch subtitle language under **更多 / 高级** without changing the default zero-click flow.

## Groq BYOK Notes

- Default model: `whisper-large-v3-turbo`, language: `auto` (no `language` field is sent in auto mode).
- Groq endpoint: `https://api.groq.com/openai/v1/audio/transcriptions` with `response_format=verbose_json`.
- Audio URLs are resolved in the page context; the Groq request itself runs in the extension popup context.
- YouTube audio prefers low-bitrate audio-only InnerTube streams; Bilibili audio prefers the lowest-bitrate DASH audio stream.
- Large audio files are rejected with a clear error: current version does not auto-split.

## Privacy

- Chrono does not ask you to paste browser cookies.
- Bilibili and YouTube metadata and subtitle-track discovery run in the video page context so the browser can use the active session naturally.
- Subtitle-track discovery and subtitle fetching are handled by platform page scripts, while `content/content.js` only routes popup requests.
- Extracted results are cached locally in `chrome.storage.local`; `unlimitedStorage` is used so large transcripts can be restored after reopening the popup.
- Groq API Key 仅保存在 `chrome.storage.local`。
- 只有用户主动点击“使用 Groq 转录”时才发送视频音频给 Groq。

## Project Structure

```text
extension/
  manifest.json
  content/
    content.js
  injected/
    bilibili-page.js
    youtube-page.js
  icons/
    icon.svg
    icon-16.png
    icon-32.png
    icon-48.png
    icon-128.png
  popup/
    popup.html
    popup.css
    popup.js
```

## Extension Flow

The popup sends platform-specific messages:

- `BCE_GET_BILIBILI_TRACKS`
- `BCE_EXTRACT_BILIBILI_SUBTITLE`
- `BCE_GET_BILIBILI_AUDIO_SOURCE`
- `BCE_GET_YOUTUBE_TRACKS`
- `BCE_EXTRACT_YOUTUBE_SUBTITLE`
- `BCE_GET_YOUTUBE_AUDIO_SOURCE`

`content/content.js` only routes messages. It detects the active platform, injects the matching page script, normalizes payload platform fields, and forwards the action as `getTracks`, `extractSubtitle`, or `getAudioSource`.

Platform-specific popup behavior, including message names, URL detection, video-id parsing, title cleanup, and author labels, is declared in `PLATFORM_CONFIG` instead of inline branching.

Each file in `injected/` owns the platform-specific implementation and returns the same result shape for single-video extraction: `platform`, `videoId`, `url`, `title`, `author`, `selectedTrack`, `availableTracks`, `segments`, `text`, and `warnings`.

Groq transcription results are normalized to the same result shape with `selectedTrack.id = "groq-whisper"` and `source = "asr"`, so rendering, clipboard, exports, and cache are fully reused.

## Current Scope

Chrono currently supports the active Bilibili or YouTube video page. Obsidian integration is not included.
