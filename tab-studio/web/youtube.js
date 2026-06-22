/* ============================================================================
 * youtube.js — a YouTube IFrame player wrapped to look like the transport's
 * other sources (play/pause/stop/seek/currentTime/duration/isPlaying), so the
 * tab playhead can sync to a YouTube video. Used as the "Song" source in the web
 * app, where there's no downloaded audio to play.
 *
 *   YouTubePlayer.mount(divId)            create the player div host
 *   YouTubePlayer.load(url) -> bool       cue a video (returns false if no id)
 *   YouTubePlayer.hasVideo() / isReady()
 *   YouTubePlayer.play()/pause()/stop()/seek(sec)
 *   YouTubePlayer.currentTime()/duration()/isPlaying()
 *   YouTubePlayer.title()
 * ========================================================================== */
var YouTubePlayer = (function () {
  'use strict';
  var player = null, ready = false, host = null;
  var apiLoading = false, apiReady = false;
  var videoId = null, stPlaying = false, wantPlay = false;

  function extractId(url) {
    if (!url) return null;
    var m = String(url).match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/v\/)([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]{11}$/.test(url) ? url : null;
  }

  function loadApi(cb) {
    if (apiReady || (window.YT && window.YT.Player)) { apiReady = true; cb(); return; }
    var prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () { apiReady = true; if (typeof prev === 'function') prev(); cb(); };
    if (apiLoading) return;
    apiLoading = true;
    var s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  }

  function mount(divId) { host = divId; }

  function ensurePlayer(id) {
    loadApi(function () {
      if (player) { player.cueVideoById(id); return; }
      player = new YT.Player(host, {
        width: '100%', height: '100%', videoId: id,
        playerVars: { controls: 1, rel: 0, modestbranding: 1, playsinline: 1, fs: 1 },
        events: {
          onReady: function () { ready = true; if (wantPlay) { stPlaying = true; player.playVideo(); } },
          onStateChange: function (e) {
            var S = YT.PlayerState;
            if (e.data === S.PLAYING) stPlaying = true;
            else if (e.data === S.PAUSED || e.data === S.ENDED) stPlaying = false;
          }
        }
      });
    });
  }

  function load(url) {
    var id = extractId(url);
    if (!id) return false;
    videoId = id; wantPlay = false; stPlaying = false;
    if (player && ready) player.cueVideoById(id);
    else ensurePlayer(id);
    return true;
  }

  function clear() { videoId = null; wantPlay = false; stPlaying = false; if (isReady()) { try { player.stopVideo(); } catch (e) {} } }
  function hasVideo() { return !!videoId; }
  function isReady() { return !!(ready && player); }
  function play() { wantPlay = true; stPlaying = true; if (isReady()) player.playVideo(); }
  function pause() { wantPlay = false; stPlaying = false; if (isReady()) player.pauseVideo(); }
  function stop() { wantPlay = false; stPlaying = false; if (isReady()) { try { player.pauseVideo(); player.seekTo(0, true); } catch (e) {} } }
  function seek(sec) { if (isReady()) { try { player.seekTo(Math.max(0, sec), true); } catch (e) {} } }
  function currentTime() { try { return (isReady() && player.getCurrentTime()) || 0; } catch (e) { return 0; } }
  function duration() { try { return (isReady() && player.getDuration()) || 0; } catch (e) { return 0; } }
  // isPlaying reports INTENT (set on play, cleared on pause/end) so the transport
  // doesn't finalize during the player's BUFFERING gap right after play().
  function isPlaying() { return stPlaying; }
  function title() { try { var d = player && player.getVideoData && player.getVideoData(); return (d && d.title) || ''; } catch (e) { return ''; } }

  return { mount: mount, load: load, clear: clear, hasVideo: hasVideo, isReady: isReady,
           play: play, pause: pause, stop: stop, seek: seek,
           currentTime: currentTime, duration: duration, isPlaying: isPlaying, title: title };
})();
