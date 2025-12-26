const term = new Terminal({
  convertEol: true,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 13,
  theme: { background: '#0b0d10' },
  disableStdin: true,
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);

const terminalEl = document.getElementById('terminal');
const statusEl = document.getElementById('status');
const inputForm = document.getElementById('inputForm');
const textInput = document.getElementById('textInput');
const enterButton = document.getElementById('enterButton');
const micButton = document.getElementById('micButton');
const micLabel = document.getElementById('micLabel');
const escButton = document.getElementById('escButton');
const upButton = document.getElementById('upButton');
const downButton = document.getElementById('downButton');
const imageButton = document.getElementById('imageButton');
const imageInput = document.getElementById('imageInput');

term.open(terminalEl);
fitAddon.fit();

let ws;
let wsConnected = false;
let usingEventSource = false;
let eventSource;
let recorder;
let isRecording = false;
const supportsRecording = Boolean(navigator.mediaDevices && typeof MediaRecorder !== 'undefined');
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const supportsSpeechRecognition = Boolean(SpeechRecognition);
let recognition;
let transportLabel = 'Connecting...';
let latencyTimer;
const params = new URLSearchParams(location.search);
const sessionId =
  params.get('session') ||
  `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const forceWebSocket = params.get('transport') === 'ws' || params.get('ws') === '1';

if (!supportsRecording) {
  micButton.disabled = true;
  micLabel.textContent = 'Use dictation';
  term.write('\r\n[Voice capture not supported in this browser. Use keyboard dictation.]\r\n');
}
if (!supportsSpeechRecognition) {
  term.write('\r\n[Live transcript not supported in this browser.]\r\n');
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${location.host}/ws?session=${encodeURIComponent(sessionId)}`);

  let fallbackTimer;
  if (!forceWebSocket) {
    fallbackTimer = setTimeout(() => {
      if (!wsConnected) {
        startEventSource();
      }
    }, 8000);
  }

  ws.addEventListener('open', () => {
    if (fallbackTimer) clearTimeout(fallbackTimer);
    wsConnected = true;
    transportLabel = 'Connected';
    updateStatus();
    sendResize();
  });

  ws.addEventListener('close', () => {
    if (!wsConnected) {
      if (!forceWebSocket) {
        startEventSource();
      }
      return;
    }
    transportLabel = 'Disconnected';
    updateStatus();
    wsConnected = false;
    if (!usingEventSource) {
      setTimeout(connect, 1000);
    }
  });

  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'output' && typeof message.data === 'string') {
      term.write(message.data);
    }
    if (message.type === 'exit') {
      transportLabel = 'Session ended';
      updateStatus();
      if (!usingEventSource) {
        wsConnected = false;
        setTimeout(connect, 500);
      }
    }
  });

  ws.addEventListener('error', () => {
    if (!wsConnected) {
      if (!forceWebSocket) {
        startEventSource();
      }
    }
  });
}

function sendResize() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: 'resize',
      cols: term.cols,
      rows: term.rows,
    })
  );
}

window.addEventListener('resize', () => {
  fitAddon.fit();
  sendResize();
});

function sendRaw(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data }));
  } else {
    sendInputHttp(data);
  }
}

function sendInput(text) {
  if (!text.trim()) return;
  sendRaw(text);
  setTimeout(() => {
    sendRaw('\r');
  }, 30);
  textInput.value = '';
}

async function sendInputHttp(data) {
  try {
    await fetch('/api/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: sessionId, data }),
    });
  } catch (err) {
    term.write(`\r\n[input error: ${err.message}]\r\n`);
  }
}

function startEventSource() {
  if (forceWebSocket) return;
  if (usingEventSource) return;
  usingEventSource = true;
  transportLabel = 'Connected (HTTP)';
  updateStatus();

  eventSource = new EventSource(`/api/stream?session=${encodeURIComponent(sessionId)}`);
  eventSource.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'output' && typeof message.data === 'string') {
      term.write(message.data);
    }
    if (message.type === 'exit') {
      transportLabel = 'Session ended';
      updateStatus();
      usingEventSource = false;
      eventSource.close();
      setTimeout(connect, 500);
    }
  };

  eventSource.onerror = () => {
    transportLabel = 'Reconnecting...';
    updateStatus();
  };
}

inputForm.addEventListener('submit', (event) => {
  event.preventDefault();
  sendInput(textInput.value);
});

enterButton.addEventListener('click', () => {
  if (textInput.value.trim()) {
    sendInput(textInput.value);
  } else {
    sendRaw('\r');
  }
});

escButton.addEventListener('click', () => {
  sendRaw('\u001b');
});

upButton.addEventListener('click', () => {
  sendRaw('\u001b[A');
});

downButton.addEventListener('click', () => {
  sendRaw('\u001b[B');
});

imageButton.addEventListener('click', () => {
  imageInput.click();
});

imageInput.addEventListener('change', async () => {
  const file = imageInput.files && imageInput.files[0];
  if (!file) return;

  const form = new FormData();
  form.append('image', file, file.name || 'upload.jpg');
  imageButton.disabled = true;
  imageButton.textContent = 'Uploading...';

  try {
    const response = await fetch('/api/upload-image', { method: 'POST', body: form });
    const data = await response.json();
    if (data.path) {
      term.write(`\r\n[image saved: ${data.path}]\r\n`);
      textInput.value = `Please analyze the image at ${data.path}`;
    } else {
      term.write('\r\n[image upload failed]\r\n');
    }
  } catch (err) {
    term.write(`\r\n[image upload error: ${err.message}]\r\n`);
  } finally {
    imageButton.disabled = false;
    imageButton.textContent = 'Image';
    imageInput.value = '';
  }
});

function updateStatus(latencyMs) {
  if (typeof latencyMs === 'number') {
    statusEl.textContent = `${transportLabel} • ${latencyMs}ms`;
  } else {
    statusEl.textContent = transportLabel;
  }
}

async function sampleLatency() {
  const started = performance.now();
  try {
    await fetch('/api/health', { cache: 'no-store' });
    const ms = Math.round(performance.now() - started);
    updateStatus(ms);
  } catch {
    updateStatus();
  }
}

async function startRecording() {
  if (isRecording) return;
  if (!supportsRecording) return;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const mimeTypes = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ];
  const mimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type));

  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];

  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  });

  recorder.addEventListener('stop', async () => {
    const blob = new Blob(chunks, { type: recorder.mimeType });
    stream.getTracks().forEach((track) => track.stop());
    stopLiveTranscript();
    await sendForTranscription(blob);
  });

  recorder.start();
  isRecording = true;
  micButton.classList.add('mic--recording');
  micLabel.textContent = 'Tap to send';
  textInput.placeholder = supportsSpeechRecognition ? 'Listening...' : 'Recording...';
  startLiveTranscript();
}

function stopRecording() {
  if (!recorder || !isRecording) return;
  recorder.stop();
  isRecording = false;
  micButton.classList.remove('mic--recording');
  micLabel.textContent = 'Tap to talk';
  textInput.placeholder = 'Type or use voice';
}

async function sendForTranscription(blob) {
  const form = new FormData();
  form.append('audio', blob, 'voice.webm');

  micLabel.textContent = 'Transcribing...';

  try {
    const response = await fetch('/api/transcribe', {
      method: 'POST',
      body: form,
    });
    const data = await response.json();
    if (data.text) {
      sendInput(data.text);
    } else {
      term.write('\r\n[transcription failed]\r\n');
    }
  } catch (err) {
    term.write(`\r\n[transcription error: ${err.message}]\r\n`);
  } finally {
    micLabel.textContent = 'Tap to talk';
  }
}

function startLiveTranscript() {
  if (!supportsSpeechRecognition) return;
  if (recognition) return;

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (event) => {
    let interim = '';
    let finalText = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) {
        finalText += result[0].transcript;
      } else {
        interim += result[0].transcript;
      }
    }
    const combined = `${finalText} ${interim}`.trim();
    if (combined) {
      textInput.value = combined;
    }
  };

  recognition.onerror = () => {
    stopLiveTranscript();
  };

  recognition.start();
}

function stopLiveTranscript() {
  if (!recognition) return;
  try {
    recognition.stop();
  } catch (_) {
    // ignore
  }
  recognition = null;
}

micButton.addEventListener('click', (event) => {
  event.preventDefault();
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

connect();
latencyTimer = setInterval(sampleLatency, 5000);
sampleLatency();
