"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import Hls, { type Level } from "hls.js";

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type QualityOption = { label: string; height: number; levelIndex: number; bitrate?: number };

export default function MinimalHLSPlayer() {
  const searchParams = useSearchParams();
  const videoId = searchParams.get("v");

  const muteParam = (searchParams.get("mute") || searchParams.get("muted") || "").toLowerCase();
  const startMuted = muteParam === "1" || muteParam === "true" || muteParam === "yes";

  // Player state
  const [mediaEl, setMediaEl] = useState<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [isBuffering, setIsBuffering] = useState(true);
  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [qualities, setQualities] = useState<QualityOption[]>([]);
  const [currentQuality, setCurrentQuality] = useState("Auto");
  const [showSettings, setShowSettings] = useState(false);
  const [settingsPanel, setSettingsPanel] = useState<"main" | "quality" | "speed">("main");
  const [streamUnavailable, setStreamUnavailable] = useState(false);
  const [hoverProgress, setHoverProgress] = useState<{ percent: number; time: number } | null>(null);
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  const [pauseFrameUrl, setPauseFrameUrl] = useState<string | null>(null);

  // References
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const playerShellRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const controlsHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSeekingRef = useRef(false);
  const pauseCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const setVideoNode = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    setMediaEl(node);
  }, []);

  const syncMuteParam = useCallback((muted: boolean) => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    params.delete("muted");
    if (muted) {
      params.set("mute", "true");
    } else {
      params.delete("mute");
    }
    const qs = params.toString();
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(window.history.state, "", url);
  }, []);

  const showControlsTemporarily = useCallback(() => {
    setShowControls(true);
    if (controlsHideTimer.current) clearTimeout(controlsHideTimer.current);
    controlsHideTimer.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) {
        setShowControls(false);
        setShowSettings(false);
      }
    }, 3000);
  }, []);

  const clearPauseFrame = useCallback(() => {
    setPauseFrameUrl((prev) => {
      if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const drawVideoFrameToCanvas = useCallback(() => {
    const el = videoRef.current;
    if (!el || el.readyState < 2 || !el.videoWidth || !el.videoHeight) return false;
    try {
      if (!pauseCanvasRef.current) pauseCanvasRef.current = document.createElement("canvas");
      const canvas = pauseCanvasRef.current;
      if (canvas.width !== el.videoWidth) canvas.width = el.videoWidth;
      if (canvas.height !== el.videoHeight) canvas.height = el.videoHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return false;
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
      return true;
    } catch {
      return false;
    }
  }, []);

  const publishPauseFrame = useCallback(() => {
    const canvas = pauseCanvasRef.current;
    if (!canvas || !canvas.width) return;
    try {
      const url = canvas.toDataURL("image/jpeg", 0.9);
      setPauseFrameUrl((prev) => {
        if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
        return url;
      });
    } catch {
      try {
        canvas.toBlob(
          (blob) => {
            if (!blob) return;
            setPauseFrameUrl((prev) => {
              if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
              return URL.createObjectURL(blob);
            });
          },
          "image/jpeg",
          0.9
        );
      } catch {
        /* ignore */
      }
    }
  }, []);

  const capturePauseFrame = useCallback(() => {
    if (drawVideoFrameToCanvas()) publishPauseFrame();
  }, [drawVideoFrameToCanvas, publishPauseFrame]);

  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    if (!el || streamUnavailable) return;
    if (el.paused || el.ended) {
      clearPauseFrame();
      el.play().catch(() => {});
    } else {
      capturePauseFrame();
      el.pause();
    }
  }, [capturePauseFrame, clearPauseFrame, streamUnavailable]);

  const seekTo = useCallback(
    (time: number) => {
      const el = videoRef.current;
      if (!el || !isFinite(time)) return;
      const d = el.duration || duration || 0;
      const t = Math.max(0, Math.min(time, d || time));
      isSeekingRef.current = true;
      const hls = hlsRef.current;
      if (hls) {
        try {
          hls.startLoad(t);
        } catch {
          /* ignore */
        }
      }
      try {
        el.currentTime = t;
      } catch {
        /* ignore */
      }
      setCurrentTime(t);
      window.setTimeout(() => {
        isSeekingRef.current = false;
        if (el.paused) capturePauseFrame();
        if (el.paused === false && el.readyState < 2) {
          el.play().catch(() => {});
        }
      }, 50);
    },
    [capturePauseFrame, duration]
  );

  const handleProgressClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const bar = progressRef.current;
      const el = videoRef.current;
      if (!bar || !el) return;
      const d = el.duration || duration;
      if (!d) return;
      const rect = bar.getBoundingClientRect();
      const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      seekTo(percent * d);
    },
    [seekTo, duration]
  );

  const handleProgressHover = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const bar = progressRef.current;
      const el = videoRef.current;
      if (!bar || !el) return;
      const d = el.duration || duration;
      if (!d) return;
      const rect = bar.getBoundingClientRect();
      const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      setHoverProgress({ percent, time: percent * d });
    },
    [duration]
  );

  const handleProgressPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const bar = progressRef.current;
      const el = videoRef.current;
      if (!bar || !el) return;
      const d = el.duration || duration;
      if (!d) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      isSeekingRef.current = true;
      const wasPlaying = !el.paused;

      const seekFromClientX = (clientX: number) => {
        const rect = bar.getBoundingClientRect();
        const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const t = percent * d;
        const hls = hlsRef.current;
        if (hls) {
          try {
            hls.startLoad(t);
          } catch {
            /* ignore */
          }
        }
        try {
          el.currentTime = t;
        } catch {
          /* ignore */
        }
        setCurrentTime(t);
        setHoverProgress({ percent, time: t });
      };
      seekFromClientX(e.clientX);

      const onMove = (ev: PointerEvent) => seekFromClientX(ev.clientX);
      const onUp = () => {
        isSeekingRef.current = false;
        if (wasPlaying) {
          el.play().catch(() => {});
        } else {
          capturePauseFrame();
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [duration, capturePauseFrame]
  );

  const changeVolume = useCallback((val: number) => {
    const el = videoRef.current;
    if (!el) return;
    const v = Math.max(0, Math.min(1, val));
    el.volume = v;
    el.muted = v === 0;
    setVolume(v);
    setIsMuted(v === 0);
    syncMuteParam(v === 0);
  }, [syncMuteParam]);

  const toggleMute = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.muted || el.volume === 0) {
      const restore = volume > 0 ? volume : 0.5;
      el.muted = false;
      el.volume = restore;
      setIsMuted(false);
      setVolume(restore);
      syncMuteParam(false);
    } else {
      el.muted = true;
      setIsMuted(true);
      syncMuteParam(true);
    }
  }, [volume, syncMuteParam]);

  const changePlaybackRate = useCallback((rate: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.playbackRate = rate;
    setPlaybackRate(rate);
    setShowSettings(false);
    setSettingsPanel("main");
  }, []);

  const changeQuality = useCallback((option: QualityOption | "auto") => {
    const hls = hlsRef.current;
    if (!hls) return;
    if (option === "auto") {
      hls.currentLevel = -1;
      setCurrentQuality("Auto");
    } else {
      hls.nextLevel = option.levelIndex;
      hls.currentLevel = option.levelIndex;
      setCurrentQuality(option.label);
    }
    setShowSettings(false);
    setSettingsPanel("main");
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const shell = playerShellRef.current;
    if (!shell) return;
    try {
      if (!document.fullscreenElement) {
        await shell.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const togglePiP = useCallback(async () => {
    const el = videoRef.current;
    if (!el) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await el.requestPictureInPicture();
      }
    } catch {
      /* ignore */
    }
  }, []);

  // ---------- Core HLS Setup ----------
  useEffect(() => {
    if (!videoId || !mediaEl) return;

    let cancelled = false;

    setStreamUnavailable(false);
    setIsBuffering(true);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setBuffered(0);
    setQualities([]);
    setCurrentQuality("Auto");
    setShowControls(true);
    clearPauseFrame();

    mediaEl.muted = startMuted;
    setIsMuted(startMuted);
    if (!startMuted && mediaEl.volume === 0) {
      mediaEl.volume = 1;
      setVolume(1);
    }

    if (hlsRef.current) {
      try {
        hlsRef.current.destroy();
      } catch {
        /* ignore */
      }
      hlsRef.current = null;
    }

    const hlsUrl = `/hls/${videoId}/master.m3u8`;

    // Native HLS (Safari)
    if (mediaEl.canPlayType("application/vnd.apple.mpegurl")) {
      mediaEl.src = hlsUrl;
      const onLoaded = () => {
        if (cancelled) return;
        setIsBuffering(false);
        if (mediaEl.duration && isFinite(mediaEl.duration)) setDuration(mediaEl.duration);
        try { mediaEl.currentTime = 0; } catch { /* ignore */ }
        setCurrentTime(0);
        mediaEl.play().catch(() => setShowControls(true));
      };
      const onErr = () => {
        if (cancelled) return;
        setStreamUnavailable(true);
        setIsBuffering(false);
      };
      mediaEl.addEventListener("loadedmetadata", onLoaded, { once: true });
      mediaEl.addEventListener("error", onErr, { once: true });
      return () => {
        cancelled = true;
        mediaEl.removeEventListener("loadedmetadata", onLoaded);
        mediaEl.removeEventListener("error", onErr);
        mediaEl.removeAttribute("src");
        try {
          mediaEl.load();
        } catch {
          /* ignore */
        }
      };
    }

    if (!Hls.isSupported()) {
      setStreamUnavailable(true);
      setIsBuffering(false);
      return;
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      startLevel: -1,
      startPosition: 0,
      autoStartLoad: false,
      capLevelToPlayerSize: true,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      backBufferLength: 30,
      manifestLoadingTimeOut: 12000,
      manifestLoadingMaxRetry: 3,
      levelLoadingTimeOut: 12000,
      levelLoadingMaxRetry: 3,
      fragLoadingTimeOut: 15000,
      fragLoadingMaxRetry: 4,
    });
    hlsRef.current = hls;

    hls.loadSource(hlsUrl);
    hls.attachMedia(mediaEl);

    hls.on(Hls.Events.MANIFEST_PARSED, (_evt, data) => {
      if (cancelled) return;
      const levels = data.levels || [];
      const opts: QualityOption[] = levels
        .map((lvl: Level, idx: number) => ({
          label: lvl.height ? `${lvl.height}p` : `L${idx}`,
          height: lvl.height || 0,
          levelIndex: idx,
          bitrate: lvl.bitrate ? Math.round(lvl.bitrate / 1000) : undefined,
        }))
        .sort((a, b) => b.height - a.height);
      setQualities(opts);
      setCurrentQuality("Auto");
      setIsBuffering(false);

      hls.startLoad(0);
      try {
        mediaEl.currentTime = 0;
      } catch {
        /* ignore */
      }
      setCurrentTime(0);
      mediaEl.play().catch(() => setShowControls(true));
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_evt, data) => {
      if (cancelled) return;
      if (hls.autoLevelEnabled) {
        setCurrentQuality("Auto");
      } else {
        const lvl = hls.levels[data.level];
        if (lvl?.height) setCurrentQuality(`${lvl.height}p`);
      }
    });

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (cancelled) return;
      if (!data.fatal) {
        if (data.details === "bufferStalledError") setIsBuffering(true);
        return;
      }
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        const code = data.response?.code;
        if (code === 404 || code === 403) {
          setStreamUnavailable(true);
          setIsBuffering(false);
          try {
            hls.destroy();
          } catch {
            /* ignore */
          }
          hlsRef.current = null;
          return;
        }
        hls.startLoad();
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
        return;
      }
      setStreamUnavailable(true);
      setIsBuffering(false);
      try {
        hls.destroy();
      } catch {
        /* ignore */
      }
      hlsRef.current = null;
    });

    return () => {
      cancelled = true;
      if (hlsRef.current) {
        try {
          hlsRef.current.destroy();
        } catch {
          /* ignore */
        }
        hlsRef.current = null;
      }
      try {
        mediaEl.removeAttribute("src");
        mediaEl.load();
      } catch {
        /* ignore */
      }
    };
  }, [videoId, mediaEl, clearPauseFrame, startMuted]);

  // Frame sampling during playback
  useEffect(() => {
    const el = mediaEl;
    if (!el) return;

    let stopped = false;
    let raf = 0;
    let vfcHandle: number | null = null;

    const tick = () => {
      if (stopped) return;
      if (!el.paused && !el.ended) {
        drawVideoFrameToCanvas();
      }
      if ("requestVideoFrameCallback" in el) {
        vfcHandle = (el as HTMLVideoElement & {
          requestVideoFrameCallback: (cb: () => void) => number;
        }).requestVideoFrameCallback(tick);
      } else {
        raf = requestAnimationFrame(tick);
      }
    };

    const start = () => {
      stopped = false;
      tick();
    };
    const stop = () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      try {
        const cancel = (el as HTMLVideoElement & {
          cancelVideoFrameCallback?: (h: number) => void;
        }).cancelVideoFrameCallback;
        if (vfcHandle != null && cancel) cancel.call(el, vfcHandle);
      } catch {
        /* ignore */
      }
    };

    el.addEventListener("play", start);
    el.addEventListener("playing", start);
    el.addEventListener("pause", stop);
    el.addEventListener("ended", stop);
    if (!el.paused) start();

    return () => {
      stop();
      el.removeEventListener("play", start);
      el.removeEventListener("playing", start);
      el.removeEventListener("pause", stop);
      el.removeEventListener("ended", stop);
    };
  }, [mediaEl, drawVideoFrameToCanvas]);

  // Video Event Listeners
  useEffect(() => {
    const el = mediaEl;
    if (!el) return;

    const onPlay = () => {
      setIsPlaying(true);
      clearPauseFrame();
      showControlsTemporarily();
    };
    const onPause = () => {
      setIsPlaying(false);
      setShowControls(true);
      if (controlsHideTimer.current) clearTimeout(controlsHideTimer.current);
      publishPauseFrame();
      requestAnimationFrame(() => {
        drawVideoFrameToCanvas();
        publishPauseFrame();
      });
    };
    const onTimeUpdate = () => {
      if (!isSeekingRef.current) setCurrentTime(el.currentTime);
    };
    const onDurationChange = () => {
      if (el.duration && isFinite(el.duration) && el.duration > 0) setDuration(el.duration);
    };
    const onLoadedMetadata = () => {
      if (el.duration && isFinite(el.duration) && el.duration > 0) setDuration(el.duration);
    };
    const onProgress = () => {
      if (el.buffered.length > 0) setBuffered(el.buffered.end(el.buffered.length - 1));
    };
    const onWaiting = () => setIsBuffering(true);
    const onCanPlay = () => setIsBuffering(false);
    const onEnded = () => {
      setIsPlaying(false);
      setShowControls(true);
      capturePauseFrame();
    };
    const onVolumeChange = () => {
      setVolume(el.volume);
      setIsMuted(el.muted || el.volume === 0);
    };
    const onPlaying = () => {
      setIsBuffering(false);
      clearPauseFrame();
    };

    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("durationchange", onDurationChange);
    el.addEventListener("loadedmetadata", onLoadedMetadata);
    el.addEventListener("progress", onProgress);
    el.addEventListener("waiting", onWaiting);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("canplay", onCanPlay);
    el.addEventListener("ended", onEnded);
    el.addEventListener("volumechange", onVolumeChange);

    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("durationchange", onDurationChange);
      el.removeEventListener("loadedmetadata", onLoadedMetadata);
      el.removeEventListener("progress", onProgress);
      el.removeEventListener("waiting", onWaiting);
      el.removeEventListener("canplay", onCanPlay);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("volumechange", onVolumeChange);
    };
  }, [mediaEl, showControlsTemporarily, capturePauseFrame, clearPauseFrame, drawVideoFrameToCanvas, publishPauseFrame]);

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Keyboard Shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      const el = videoRef.current;
      if (!el) return;
      switch (e.key.toLowerCase()) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "arrowleft":
        case "j":
          e.preventDefault();
          seekTo(el.currentTime - 5);
          showControlsTemporarily();
          break;
        case "arrowright":
        case "l":
          e.preventDefault();
          seekTo(el.currentTime + 5);
          showControlsTemporarily();
          break;
        case "arrowup":
          e.preventDefault();
          changeVolume(Math.min(1, (el.muted ? 0 : el.volume) + 0.05));
          showControlsTemporarily();
          break;
        case "arrowdown":
          e.preventDefault();
          changeVolume(Math.max(0, (el.muted ? 0 : el.volume) - 0.05));
          showControlsTemporarily();
          break;
        case "m":
          e.preventDefault();
          toggleMute();
          showControlsTemporarily();
          break;
        case "f":
          e.preventDefault();
          toggleFullscreen();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekTo, changeVolume, toggleMute, toggleFullscreen, showControlsTemporarily]);

  if (!videoId) {
    return (
      <div className="w-full h-screen bg-black text-white flex items-center justify-center">
        <p>No video ID provided in query parameters (?v=...)</p>
      </div>
    );
  }

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? (buffered / duration) * 100 : 0;

  return (
    <div className="w-full h-screen bg-black flex items-center justify-center">
      <div className="w-full h-full relative aspect-video">
        <div
          ref={playerShellRef}
          className="relative z-10 w-full h-full overflow-hidden bg-black select-none"
          onMouseMove={showControlsTemporarily}
          onMouseLeave={() => {
            if (isPlaying) {
              setShowControls(false);
              setShowSettings(false);
            }
            setShowVolumeSlider(false);
          }}
          onDoubleClick={toggleFullscreen}
        >
          <video
            ref={setVideoNode}
            key={videoId}
            playsInline
            preload="auto"
            className={`block w-full h-full object-contain bg-black ${
              !isPlaying && pauseFrameUrl ? "opacity-0" : "opacity-100"
            }`}
            onClick={togglePlay}
          />

          {pauseFrameUrl && !isPlaying && (
            <img
              src={pauseFrameUrl}
              alt=""
              draggable={false}
              className="absolute inset-0 w-full h-full object-contain bg-black pointer-events-none z-[15]"
              style={{ imageRendering: "auto" }}
            />
          )}

          {isBuffering && !streamUnavailable && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
              <div className="w-12 h-12 border-[3px] border-white/30 border-t-white rounded-full animate-spin" />
            </div>
          )}

          {streamUnavailable && (
            <div className="absolute inset-0 flex flex-col items-center justify-center z-30 bg-black/90 text-white px-4 text-center">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" className="opacity-60 mb-3">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
              </svg>
              <p className="text-lg font-medium">Video not available</p>
              <p className="text-sm text-white/60 mt-1">Stream could not be loaded from the server.</p>
              <button
                type="button"
                className="mt-4 px-4 py-2 rounded-full bg-white/15 hover:bg-white/25 text-sm"
                onClick={() => {
                  setStreamUnavailable(false);
                  const node = videoRef.current;
                  setMediaEl(null);
                  requestAnimationFrame(() => {
                    if (node) setMediaEl(node);
                  });
                }}
              >
                Try again
              </button>
            </div>
          )}

          {!isPlaying && !isBuffering && !streamUnavailable && (
            <button
              type="button"
              onClick={togglePlay}
              className="absolute inset-0 flex items-center justify-center z-20 cursor-pointer"
              aria-label="Play"
            >
              <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-black/60 backdrop-blur-sm flex items-center justify-center hover:bg-black/80 hover:scale-105 transition-all">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="white">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            </button>
          )}

          {!streamUnavailable && (
            <div
              className={`absolute inset-x-0 bottom-0 z-30 transition-opacity duration-300 ${
                showControls || !isPlaying ? "opacity-100" : "opacity-0 pointer-events-none"
              }`}
            >
              <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent pointer-events-none h-32 bottom-0" />
              <div className="relative px-3 pb-2 pt-8">
                <div
                  ref={progressRef}
                  className="group/progress relative h-1.5 hover:h-2 cursor-pointer mb-2 transition-all touch-none"
                  onClick={handleProgressClick}
                  onPointerDown={handleProgressPointerDown}
                  onMouseMove={handleProgressHover}
                  onMouseLeave={() => setHoverProgress(null)}
                >
                  <div
                    className="absolute inset-y-0 left-0 bg-white/30 rounded-full"
                    style={{ width: `${bufferedPercent}%` }}
                  />
                  <div
                    className="absolute inset-y-0 left-0 bg-red-600 rounded-full"
                    style={{ width: `${progressPercent}%` }}
                  />
                  <div
                    className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-red-600 rounded-full opacity-0 group-hover/progress:opacity-100 transition-opacity shadow"
                    style={{ left: `calc(${progressPercent}% - 6px)` }}
                  />
                  {hoverProgress && (
                    <div
                      className="absolute -top-8 -translate-x-1/2 px-1.5 py-0.5 rounded bg-black/90 text-white text-[11px] font-medium whitespace-nowrap pointer-events-none"
                      style={{ left: `${hoverProgress.percent * 100}%` }}
                    >
                      {formatTime(hoverProgress.time)}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-1 sm:gap-2 text-white">
                  <button
                    type="button"
                    onClick={togglePlay}
                    className="p-1.5 hover:bg-white/10 rounded-full transition-colors"
                    aria-label={isPlaying ? "Pause" : "Play"}
                  >
                    {isPlaying ? (
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                      </svg>
                    ) : (
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    )}
                  </button>

                  <div
                    className="relative flex items-center"
                    onMouseEnter={() => setShowVolumeSlider(true)}
                    onMouseLeave={() => setShowVolumeSlider(false)}
                  >
                    <button
                      type="button"
                      onClick={toggleMute}
                      className="p-1.5 hover:bg-white/10 rounded-full transition-colors"
                      aria-label={isMuted ? "Unmute" : "Mute"}
                    >
                      {isMuted || volume === 0 ? (
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                        </svg>
                      ) : volume < 0.5 ? (
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
                        </svg>
                      ) : (
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                        </svg>
                      )}
                    </button>
                    <div
                      className={`overflow-hidden transition-all duration-200 ${
                        showVolumeSlider ? "w-20 opacity-100 ml-1" : "w-0 opacity-0"
                      }`}
                    >
                      <div
                        className="relative h-1 bg-white/30 rounded-full cursor-pointer"
                        onClick={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                          changeVolume(p);
                        }}
                      >
                        <div
                          className="absolute inset-y-0 left-0 bg-white rounded-full"
                          style={{ width: `${(isMuted ? 0 : volume) * 100}%` }}
                        />
                      </div>
                    </div>
                  </div>

                  <span className="text-xs sm:text-sm font-medium tabular-nums ml-1 whitespace-nowrap">
                    {formatTime(currentTime)} / {formatTime(duration)}
                  </span>

                  <div className="flex-1" />

                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => {
                        setShowSettings((s) => !s);
                        setSettingsPanel("main");
                      }}
                      className="p-1.5 hover:bg-white/10 rounded-full transition-colors"
                      aria-label="Settings"
                    >
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87a.48.48 0 00.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 00-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1112 8.4a3.6 3.6 0 010 7.2z" />
                      </svg>
                    </button>

                    {showSettings && (
                      <div className="absolute bottom-full right-0 mb-2 w-56 rounded-lg bg-[#212121] shadow-xl border border-white/10 overflow-hidden text-sm z-50">
                        {settingsPanel === "main" && (
                          <div className="py-1">
                            <button
                              type="button"
                              className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-white/10"
                              onClick={() => setSettingsPanel("speed")}
                            >
                              <span>Playback speed</span>
                              <span className="text-white/60">
                                {playbackRate === 1 ? "Normal" : `${playbackRate}x`}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-white/10"
                              onClick={() => setSettingsPanel("quality")}
                            >
                              <span>Quality</span>
                              <span className="text-white/60">{currentQuality}</span>
                            </button>
                          </div>
                        )}

                        {settingsPanel === "speed" && (
                          <div className="py-1">
                            <button
                              type="button"
                              className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-white/10 font-semibold border-b border-white/10"
                              onClick={() => setSettingsPanel("main")}
                            >
                              ← Playback speed
                            </button>
                            {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => (
                              <button
                                key={rate}
                                type="button"
                                className={`w-full flex items-center gap-3 px-4 py-2 hover:bg-white/10 ${
                                  playbackRate === rate ? "text-red-500 font-bold" : ""
                                }`}
                                onClick={() => changePlaybackRate(rate)}
                              >
                                <span className="w-5">{playbackRate === rate ? "✓" : ""}</span>
                                {rate === 1 ? "Normal" : `${rate}x`}
                              </button>
                            ))}
                          </div>
                        )}

                        {settingsPanel === "quality" && (
                          <div className="py-1 max-h-64 overflow-y-auto">
                            <button
                              type="button"
                              className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-white/10 font-semibold border-b border-white/10"
                              onClick={() => setSettingsPanel("main")}
                            >
                              ← Quality
                            </button>
                            <button
                              type="button"
                              className={`w-full flex items-center gap-3 px-4 py-2 hover:bg-white/10 ${
                                currentQuality === "Auto" ? "text-red-500 font-bold" : ""
                              }`}
                              onClick={() => changeQuality("auto")}
                            >
                              <span className="w-5">{currentQuality === "Auto" ? "✓" : ""}</span>
                              Auto
                            </button>
                            {qualities.map((q) => (
                              <button
                                key={q.levelIndex}
                                type="button"
                                className={`w-full flex items-center gap-3 px-4 py-2 hover:bg-white/10 ${
                                  currentQuality === q.label ? "text-red-500 font-bold" : ""
                                }`}
                                onClick={() => changeQuality(q)}
                              >
                                <span className="w-5">{currentQuality === q.label ? "✓" : ""}</span>
                                {q.label}
                                {q.bitrate ? (
                                  <span className="text-white/40 text-xs ml-auto">{q.bitrate} kbps</span>
                                ) : null}
                              </button>
                            ))}
                            {qualities.length === 0 && (
                              <p className="px-4 py-2 text-white/40 text-xs">Loading qualities…</p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={togglePiP}
                    className="p-1.5 hover:bg-white/10 rounded-full transition-colors hidden sm:block"
                    aria-label="Picture in picture"
                  >
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14z" />
                    </svg>
                  </button>

                  <button
                    type="button"
                    onClick={toggleFullscreen}
                    className="p-1.5 hover:bg-white/10 rounded-full transition-colors"
                    aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                  >
                    {isFullscreen ? (
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                      </svg>
                    ) : (
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
