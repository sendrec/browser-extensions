// Offscreen document handles actual MediaRecorder APIs
// since service workers can't access getUserMedia/getDisplayMedia

let screenRecorder = null;
let webcamRecorder = null;
let screenChunks = [];
let webcamChunks = [];
let screenStream = null;
let webcamStream = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  switch (msg.type) {
    case 'OFFSCREEN_START':
      handleStart(msg.options);
      break;
    case 'OFFSCREEN_PAUSE':
      handlePause();
      break;
    case 'OFFSCREEN_RESUME':
      handleResume();
      break;
    case 'OFFSCREEN_STOP':
      handleStop();
      break;
  }
});

async function handleStart(options) {
  try {
    screenChunks = [];
    webcamChunks = [];

    const includesScreen = options.source === 'screen' || options.source === 'tab';
    const includesWebcam = options.webcam;

    // Get screen/tab stream
    if (includesScreen) {
      const displayMediaOptions = {
        video: true,
        audio: false
      };

      screenStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);

      // Add microphone if requested
      if (options.micAudio) {
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: false
          });

          // Create combined stream: screen video + mic audio
          const combinedStream = new MediaStream([
            ...screenStream.getVideoTracks(),
            ...micStream.getAudioTracks()
          ]);

          screenStream = combinedStream;
        } catch (micErr) {
          console.warn('Microphone access denied, recording without mic:', micErr);
        }
      }

      screenRecorder = new MediaRecorder(screenStream, {
        mimeType: getSupportedMimeType(),
        videoBitsPerSecond: 2500000
      });

      screenRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          screenChunks.push(e.data);
        }
      };

      screenRecorder.onstop = () => {
        finishRecording();
      };

      // Stop if user clicks "Stop sharing" in browser UI
      screenStream.getVideoTracks()[0].onended = () => {
        handleStop();
      };

      screenRecorder.start(1000); // Collect data every second

      // Notify background that recording has actually started
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_RECORDING_STARTED' });
    }

    // Get webcam stream
    if (includesWebcam) {
      try {
        webcamStream = await navigator.mediaDevices.getUserMedia({
          video: { width: 320, height: 240, facingMode: 'user' },
          audio: !includesScreen && options.micAudio // Only capture audio on webcam if no screen
        });

        webcamRecorder = new MediaRecorder(webcamStream, {
          mimeType: getSupportedMimeType(),
          videoBitsPerSecond: 800000
        });

        webcamRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            webcamChunks.push(e.data);
          }
        };

        webcamRecorder.start(1000);
      } catch (webcamErr) {
        console.warn('Webcam access denied:', webcamErr);
      }
    }

    // Webcam-only mode
    if (!includesScreen && includesWebcam) {
      if (!webcamRecorder) {
        throw new Error('Webcam access denied');
      }
      // Use webcam as the main recorder for stop handling
      screenRecorder = webcamRecorder;
      screenChunks = webcamChunks;
      // Re-point the handler: it captured the `webcamChunks` variable, which is
      // rebound to a new array below, so chunks would never reach screenChunks.
      screenRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          screenChunks.push(e.data);
        }
      };
      webcamRecorder = null;
      webcamChunks = [];

      screenRecorder.onstop = () => {
        finishRecording();
      };

      // Notify background that recording has actually started (webcam-only)
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_RECORDING_STARTED' });
    }
  } catch (err) {
    const msg = (err.name === 'NotAllowedError' || (err.message && err.message.includes('Permission denied')))
      ? 'Screen sharing was cancelled.'
      : (err.message || 'Recording cancelled');
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_UPLOAD_ERROR',
      error: msg
    });
  }
}

function handlePause() {
  if (screenRecorder && screenRecorder.state === 'recording') {
    screenRecorder.pause();
  }
  if (webcamRecorder && webcamRecorder.state === 'recording') {
    webcamRecorder.pause();
  }
}

function handleResume() {
  if (screenRecorder && screenRecorder.state === 'paused') {
    screenRecorder.resume();
  }
  if (webcamRecorder && webcamRecorder.state === 'paused') {
    webcamRecorder.resume();
  }
}

function handleStop() {
  if (screenRecorder && screenRecorder.state !== 'inactive') {
    screenRecorder.stop();
  }
  if (webcamRecorder && webcamRecorder.state !== 'inactive') {
    webcamRecorder.stop();
  }

  // Stop all tracks
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
  }
  if (webcamStream) {
    webcamStream.getTracks().forEach(t => t.stop());
  }
}

async function finishRecording() {
  // Small delay to ensure all chunks are collected
  await new Promise(r => setTimeout(r, 200));

  const mimeType = getSupportedMimeType();
  const screenBlob = new Blob(screenChunks, { type: mimeType });

  // Don't upload if recording was empty (cancelled immediately)
  if (screenBlob.size === 0) {
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_UPLOAD_ERROR',
      error: 'Recording was empty'
    });
    cleanup();
    return;
  }

  let webcamBlob = null;
  if (webcamChunks.length > 0) {
    webcamBlob = new Blob(webcamChunks, { type: mimeType });
  }

  // Upload directly from offscreen (avoids message size limits)
  try {
    await uploadToSendRec(screenBlob, webcamBlob, mimeType);
  } catch (err) {
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_UPLOAD_ERROR',
      error: err.message
    });
  }

  cleanup();
}

function cleanup() {
  screenRecorder = null;
  webcamRecorder = null;
  screenChunks = [];
  webcamChunks = [];
  screenStream = null;
  webcamStream = null;
}

// Aborting only after two minutes without a single byte moving tolerates
// Wi-Fi roaming, VPN reconnects and bursty progress on slow links.
const STALL_TIMEOUT_MS = 120000;

// Fetch with an overall deadline. Used for the small JSON API calls.
async function fetchWithTimeout(url, options, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`${label} timed out after ${Math.floor(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Blob PUT via XHR so upload progress events can drive real stall detection.
// fetch() exposes no upload progress, so a wall-clock timer there would abort
// healthy long uploads and leave a truncated object on the server.
function putBlobWithStallDetection(url, blob, contentType, timeoutMs, label, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let stallTimer = null;
    let abortReason = null;

    const clearStallTimer = () => {
      if (stallTimer !== null) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    };

    const armStallTimer = () => {
      clearStallTimer();
      stallTimer = setTimeout(() => {
        abortReason = `${label} stalled (no progress for ${Math.floor(STALL_TIMEOUT_MS / 1000)}s)`;
        xhr.abort();
      }, STALL_TIMEOUT_MS);
    };

    // Enforced here rather than via xhr.timeout so the abort reason survives
    // into the rejection message.
    const mainTimer = setTimeout(() => {
      abortReason = `${label} timed out after ${Math.floor(timeoutMs / 1000)}s`;
      xhr.abort();
    }, timeoutMs);

    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearStallTimer();
      clearTimeout(mainTimer);
      fn(arg);
    };

    xhr.upload.onprogress = (e) => {
      armStallTimer();
      if (onProgress && e.lengthComputable && e.total > 0) {
        onProgress(e.loaded / e.total);
      }
    };
    xhr.upload.onloadend = () => clearStallTimer();
    xhr.onload = () => settle(resolve, { ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status });
    xhr.onerror = () => settle(reject, new Error(`${label} failed: network error`));
    xhr.onabort = () => settle(reject, new Error(abortReason || `${label} aborted`));

    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Type', contentType);
    armStallTimer();
    xhr.send(blob);
  });
}

// Calculate upload timeout based on file size.
// Assumes a floor of 100 KiB/s upstream plus a 60s buffer. The upper bound
// stays under the server's 30 minute presigned URL lifetime, past which S3
// rejects the PUT anyway.
function getUploadTimeout(fileSizeBytes) {
  const minSpeedBytesPerSec = 100 * 1024;
  const bufferMs = 60000;
  const estimatedMs = (fileSizeBytes / minSpeedBytesPerSec) * 1000 + bufferMs;
  return Math.min(Math.max(estimatedMs, 180000), 28 * 60 * 1000);
}

async function uploadToSendRec(screenBlob, webcamBlob, mimeType) {
  const config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
  if (!config || !config.serverUrl || !config.accessToken) {
    throw new Error(config?.error || 'Not signed in. Open extension settings to sign in.');
  }

  const serverUrl = config.serverUrl.replace(/\/$/, '');
  const token = config.accessToken;

  // Get duration from background
  const stateRes = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  const duration = stateRes.elapsed || 1;

  const body = {
    title: `Recording ${new Date().toLocaleString()}`,
    duration: duration,
    fileSize: screenBlob.size,
    contentType: mimeType.split(';')[0] // Use base mime type without codecs
  };

  if (webcamBlob) {
    body.webcamFileSize = webcamBlob.size;
    body.webcamContentType = mimeType.split(';')[0];
  }

  // Step 1: Create video record
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_UPLOAD_PROGRESS', progress: 10 });

  const createHeaders = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
  if (config.organizationId) {
    createHeaders['X-Organization-Id'] = config.organizationId;
  }

  const createRes = await fetchWithTimeout(`${serverUrl}/api/videos`, {
    method: 'POST',
    credentials: 'include',
    headers: createHeaders,
    body: JSON.stringify(body)
  }, 30000, 'Create video request');

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`Failed to create video: ${createRes.status} ${errText}`);
  }

  const videoData = await createRes.json();
  const { id, uploadUrl, shareToken } = videoData;

  // Step 2: Upload screen recording to presigned URL
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_UPLOAD_PROGRESS', progress: 30 });

  const uploadRes = await putBlobWithStallDetection(
    uploadUrl,
    screenBlob,
    body.contentType,
    getUploadTimeout(screenBlob.size),
    'Screen upload',
    (fraction) => {
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_UPLOAD_PROGRESS',
        progress: 30 + Math.round(fraction * 40)
      });
    }
  );

  if (!uploadRes.ok) {
    throw new Error(`Failed to upload video: ${uploadRes.status}`);
  }

  chrome.runtime.sendMessage({ type: 'OFFSCREEN_UPLOAD_PROGRESS', progress: 70 });

  // A webcam failure must not abort the flow — the screen recording is already
  // uploaded and would stay stuck in 'uploading' if we never reached finalize.
  if (webcamBlob && videoData.webcamUploadUrl) {
    try {
      const wcRes = await putBlobWithStallDetection(
        videoData.webcamUploadUrl,
        webcamBlob,
        body.webcamContentType,
        getUploadTimeout(webcamBlob.size),
        'Webcam upload'
      );
      if (!wcRes.ok) {
        console.warn('Webcam upload failed:', wcRes.status);
      }
    } catch (err) {
      console.warn('Webcam upload failed:', err);
    }
  }

  chrome.runtime.sendMessage({ type: 'OFFSCREEN_UPLOAD_PROGRESS', progress: 90 });

  // Step 3: Mark as ready
  const finalizeRes = await fetchWithTimeout(`${serverUrl}/api/videos/${id}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ status: 'ready' })
  }, 30000, 'Finalize video request');

  // Without this check the recording is reported as uploaded while the server
  // rejected verification and leaves it stuck in the 'uploading' state.
  if (!finalizeRes.ok) {
    const errText = await finalizeRes.text().catch(() => '');
    throw new Error(`Failed to finalize video: ${finalizeRes.status} ${errText}`);
  }

  // Done
  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_UPLOAD_DONE',
    shareUrl: `${serverUrl}/watch/${shareToken}`
  });
}

function getSupportedMimeType() {
  const types = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return 'video/webm';
}
