"use strict";
// Vidéo 360 : frame courante, lecture, sauts entre débuts / fins de tracks.

// ------------------------------------------------------------------ vidéo / frames
function setFrame(f, seekVideo = true) {
  f = Math.max(0, Math.min(C.n_frames - 1, f | 0));
  frame = f;
  if (seekVideo && C.video_ok) { video.pause(); video.currentTime = (f + 0.5) / C.fps; }
  renderFrame(); syncDrone();
}

function onVideoFrame(_now, meta) {
  if (C) {
    const f = Math.round(meta.mediaTime * C.fps);
    if (f !== frame) { frame = Math.min(f, C.n_frames - 1); renderFrame(); }
    else renderLoupes();
    syncDrone();
  }
  video.requestVideoFrameCallback(onVideoFrame);
}
if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) video.requestVideoFrameCallback(onVideoFrame);
else video.addEventListener("timeupdate", () => { if (C) { frame = Math.floor(video.currentTime * C.fps); renderFrame(); } });
video.addEventListener("play", () => $("btnPlay").textContent = "❚❚");
video.addEventListener("pause", () => $("btnPlay").textContent = "▶");
video.addEventListener("seeked", () => renderLoupes());

