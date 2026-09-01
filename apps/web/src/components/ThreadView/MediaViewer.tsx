import React, { useState, useRef } from 'react';
import {
  FileText,
  Download,
  Play,
  Pause,
  Maximize2,
  X,
  Loader2,
} from 'lucide-react';
import { api } from '../../api/client.ts';
import type { UnifiedMessage } from '../../types.ts';

interface MediaViewerProps {
  msg: UnifiedMessage;
  chatJid: string;
}

export const MediaViewer: React.FC<MediaViewerProps> = ({ msg, chatJid }) => {
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [localPath, setLocalPath] = useState<string | null>(msg.localPath || null);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);

  // Audio Player State
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const mediaType = msg.mediaType || 'document';
  // Stickers carry no filename of their own, and the generic
  // `sticker_attachment` fallback has no extension — so a saved sticker lands as
  // a file the OS cannot open. They are always WebP, so name it as such.
  const filename =
    msg.filename || (mediaType === 'sticker' ? 'sticker.webp' : `${mediaType}_attachment`);

  const mediaSrc = api.getMediaUrl({
    chat: chatJid,
    id: msg.msgId,
    path: localPath || undefined,
  });

  const downloadSrc = api.getMediaUrl({
    chat: chatJid,
    id: msg.msgId,
    path: localPath || undefined,
    download: true,
    filename,
  });

  const handleManualDownload = async () => {
    setIsDownloading(true);
    setDownloadError(null);
    try {
      const res = await api.downloadMedia({ chat: chatJid, id: msg.msgId });
      if (res.localPath) {
        setLocalPath(res.localPath);
      }
    } catch (err: unknown) {
      const errorText = err instanceof Error ? err.message : String(err);
      setDownloadError(errorText);
    } finally {
      setIsDownloading(false);
    }
  };

  const togglePlayAudio = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => {
          // If playback fails, try downloading first
          handleManualDownload();
        });
    }
  };

  const togglePlaybackRate = () => {
    if (!audioRef.current) return;
    const nextRate = playbackRate === 1 ? 1.5 : playbackRate === 1.5 ? 2 : 1;
    audioRef.current.playbackRate = nextRate;
    setPlaybackRate(nextRate);
  };

  const formatTime = (seconds: number) => {
    if (isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  // 1. IMAGE PREVIEW (Photos)
  if (mediaType === 'image') {
    return (
      <div className="mb-2 space-y-1.5">
        <div className="relative group/media overflow-hidden rounded-md border border-mc-border bg-black/40 max-w-sm">
          <img
            src={mediaSrc}
            alt={msg.mediaCaption || filename}
            className="w-full max-h-72 object-cover cursor-pointer hover:scale-[1.02] transition-transform duration-200"
            onClick={() => setIsLightboxOpen(true)}
            onError={() => {
              // Image not downloaded yet or failed load
            }}
          />
          <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover/media:opacity-100 transition-opacity bg-black/70 backdrop-blur-sm rounded px-1.5 py-1">
            <button
              onClick={() => setIsLightboxOpen(true)}
              className="p-1 hover:text-mc-live text-mc-text transition-colors"
              title="View full size"
            >
              <Maximize2 size={13} />
            </button>
            <a
              href={downloadSrc}
              download={filename}
              className="p-1 hover:text-mc-live text-mc-text transition-colors"
              title="Download image"
            >
              <Download size={13} />
            </a>
          </div>
        </div>

        {/* Lightbox Modal */}
        {isLightboxOpen && (
          <div
            className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex flex-col items-center justify-center p-4 select-none"
            onClick={() => setIsLightboxOpen(false)}
          >
            <div
              className="relative max-w-4xl max-h-[90vh] flex flex-col items-center space-y-3"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between w-full text-xs font-mono text-mc-textMuted px-2">
                <span className="truncate max-w-md">{filename}</span>
                <div className="flex items-center gap-3">
                  <a
                    href={downloadSrc}
                    download={filename}
                    className="flex items-center gap-1 bg-mc-surface hover:bg-mc-surfaceHover border border-mc-border px-2.5 py-1 rounded text-mc-text hover:text-mc-live transition-colors"
                  >
                    <Download size={13} />
                    <span>DOWNLOAD</span>
                  </a>
                  <button
                    onClick={() => setIsLightboxOpen(false)}
                    className="p-1.5 rounded bg-mc-surface hover:bg-mc-surfaceHover border border-mc-border text-mc-text hover:text-mc-danger transition-colors"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
              <img
                src={mediaSrc}
                alt={filename}
                className="max-h-[80vh] max-w-full rounded shadow-2xl object-contain border border-mc-border/50"
              />
              {msg.mediaCaption && (
                <div className="text-xs text-mc-text text-center max-w-xl px-4 py-2 bg-mc-surface/80 rounded border border-mc-border font-sans select-text cursor-text">
                  {msg.mediaCaption}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // 2. STICKER PREVIEW
  // Deliberately bare compared to the image branch: stickers are 512x512 WebP
  // with a transparent background (often animated), so a card background would
  // show through the transparency and `object-cover` would crop the art.
  if (mediaType === 'sticker') {
    return (
      <div className="mb-2 relative inline-block group/sticker">
        <img
          src={mediaSrc}
          alt={msg.mediaCaption || 'Sticker'}
          className="w-32 h-32 object-contain"
          loading="lazy"
        />
        <a
          href={downloadSrc}
          download={filename}
          className="absolute top-1 right-1 p-1 rounded bg-black/70 backdrop-blur-sm text-mc-text hover:text-mc-live opacity-0 group-hover/sticker:opacity-100 focus:opacity-100 transition-opacity"
          title="Download sticker"
        >
          <Download size={12} />
        </a>
      </div>
    );
  }

  // 3. AUDIO PREVIEW (Voice notes & audio recordings)
  if (mediaType === 'audio') {
    return (
      <div className="mb-2 p-2.5 rounded-md bg-mc-bg/70 border border-mc-border flex flex-col gap-2 min-w-[240px] max-w-xs font-mono">
        <audio
          ref={audioRef}
          src={mediaSrc}
          onTimeUpdate={() => {
            if (audioRef.current) {
              setCurrentTime(audioRef.current.currentTime);
            }
          }}
          onLoadedMetadata={() => {
            if (audioRef.current) {
              setDuration(audioRef.current.duration);
            }
          }}
          onEnded={() => setIsPlaying(false)}
          onError={() => {
            setIsPlaying(false);
          }}
        />

        <div className="flex items-center gap-2.5">
          <button
            onClick={togglePlayAudio}
            disabled={isDownloading}
            className="w-8 h-8 rounded-full bg-mc-live text-[#12151B] flex items-center justify-center hover:bg-mc-live/90 transition-transform active:scale-95 shrink-0"
            title={isPlaying ? 'Pause voice note' : 'Play voice note'}
          >
            {isDownloading ? (
              <Loader2 size={15} className="animate-spin" />
            ) : isPlaying ? (
              <Pause size={15} />
            ) : (
              <Play size={15} className="ml-0.5" />
            )}
          </button>

          {/* Progress bar / waveform representation */}
          <div className="flex-1 space-y-1">
            <input
              type="range"
              min={0}
              max={duration || 100}
              value={currentTime}
              onChange={(e) => {
                const newTime = Number(e.target.value);
                setCurrentTime(newTime);
                if (audioRef.current) {
                  audioRef.current.currentTime = newTime;
                }
              }}
              className="w-full h-1 bg-mc-border rounded-lg appearance-none cursor-pointer accent-mc-live"
            />
            <div className="flex justify-between text-[10px] text-mc-textMuted">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          {/* Speed & Download buttons */}
          <div className="flex items-center gap-1">
            <button
              onClick={togglePlaybackRate}
              className="text-[10px] px-1.5 py-0.5 rounded bg-mc-surface border border-mc-border text-mc-text hover:text-mc-live transition-colors"
              title="Change playback speed"
            >
              {playbackRate}x
            </button>
            <a
              href={downloadSrc}
              download={filename}
              className="p-1 text-mc-textMuted hover:text-mc-live transition-colors"
              title="Download voice note"
            >
              <Download size={13} />
            </a>
          </div>
        </div>

        {downloadError && (
          <div className="text-[10px] text-mc-danger flex items-center justify-between">
            <span className="truncate">{downloadError}</span>
            <button onClick={handleManualDownload} className="underline hover:text-mc-text">
              Retry
            </button>
          </div>
        )}
      </div>
    );
  }

  // 4. VIDEO PREVIEW
  if (mediaType === 'video') {
    return (
      <div className="mb-2 space-y-1.5 max-w-sm">
        <div className="rounded-md border border-mc-border overflow-hidden bg-black/60">
          <video
            controls
            src={mediaSrc}
            className="w-full max-h-72 object-contain"
            preload="metadata"
          />
        </div>
        <div className="flex items-center justify-between text-[11px] font-mono text-mc-textMuted px-1">
          <span className="truncate">{filename}</span>
          <a
            href={downloadSrc}
            download={filename}
            className="flex items-center gap-1 text-mc-live hover:underline"
          >
            <Download size={12} />
            <span>DOWNLOAD</span>
          </a>
        </div>
      </div>
    );
  }

  // 5. DOCUMENT & FILE DOWNLOADER
  return (
    <div className="mb-2 p-2.5 rounded-md bg-mc-bg/80 border border-mc-border flex items-center justify-between gap-3 font-mono text-xs max-w-sm">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="w-8 h-8 rounded bg-mc-surface border border-mc-border flex items-center justify-center text-mc-live shrink-0">
          <FileText size={16} />
        </div>
        <div className="min-w-0">
          <div className="text-mc-text font-semibold truncate text-[11px]" title={filename}>
            {filename}
          </div>
          <div className="text-[10px] text-mc-textMuted uppercase">
            {msg.mimeType || `${mediaType} document`}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <a
          href={downloadSrc}
          download={filename}
          className="flex items-center gap-1 px-2.5 py-1 rounded bg-mc-surface hover:bg-mc-surfaceHover border border-mc-border text-mc-live hover:text-mc-live text-[11px] font-bold transition-colors"
          title="Download file"
        >
          <Download size={12} />
          <span>GET</span>
        </a>
      </div>
    </div>
  );
};
