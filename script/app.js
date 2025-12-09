// scripts/app.js
// Frontend behavior for Marg-Ai (kept compact and robust).
(() => {
  const demoVideo = document.getElementById('demoVideo');
  const frameImg = document.getElementById('frameImg');
  const overlay = document.getElementById('overlay');
  const uploadInput = document.getElementById('uploadInput');
  const sendFrameBtn = document.getElementById('sendFrameBtn');
  const alertsList = document.getElementById('alertsList');
  const toggleDemoBtn = document.getElementById('toggleDemo');
  const wsBtn = document.getElementById('wsBtn');
  const connectionStatus = document.getElementById('connectionStatus');
  const emptyNote = document.getElementById('emptyNote');
  const restUrlEl = document.getElementById('restUrl');
  const wsUrlEl = document.getElementById('wsUrl');

  const BACKEND_REST_URL = window.BACKEND_REST_URL || "";
  const BACKEND_WS_URL = window.BACKEND_WS_URL || "";

  if (restUrlEl) restUrlEl.textContent = BACKEND_REST_URL || "none (demo only)";
  if (wsUrlEl) wsUrlEl.textContent = BACKEND_WS_URL || "none (demo only)";

  let demoMode = true, ws = null;
  let frameW = 640, frameH = 360, lastSent = 0;

  function drawBoxes(detections) {
    const imgEl = demoMode ? demoVideo : frameImg;
    if (!imgEl) return;
    const rect = imgEl.getBoundingClientRect();
    overlay.width = rect.width; overlay.height = rect.height;
    overlay.style.left = imgEl.offsetLeft + 'px';
    overlay.style.top = imgEl.offsetTop + 'px';
    const ctx = overlay.getContext('2d'); ctx.clearRect(0,0,overlay.width,overlay.height);
    const sw = overlay.width / frameW, sh = overlay.height / frameH;
    (detections || []).forEach(d => {
      const [x1,y1,x2,y2] = d.xyxy;
      const x = x1*sw, y = y1*sh, w = (x2-x1)*sw, h = (y2-y1)*sh;
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,80,80,0.95)'; ctx.strokeRect(x,y,w,h);
      const label = `${d.label} ${(d.conf*100).toFixed(0)}%`;
      ctx.fillStyle = 'rgba(255,80,80,0.95)';
      const measure = ctx.measureText(label).width + 12;
      ctx.fillRect(x, Math.max(0,y-26), measure, 22);
      ctx.fillStyle = '#fff'; ctx.font = '13px Inter, sans-serif'; ctx.fillText(label, x+6, y-8);
    });
  }

  function updateFrameSize() {
    const rect = (demoMode ? demoVideo : frameImg).getBoundingClientRect();
    overlay.style.width = rect.width + 'px'; overlay.style.height = rect.height + 'px';
  }

  window.addEventListener('resize', updateFrameSize);
  demoVideo.addEventListener('loadedmetadata', () => {
    frameW = demoVideo.videoWidth || frameW; frameH = demoVideo.videoHeight || frameH; updateFrameSize();
  });

  toggleDemoBtn.addEventListener('click', () => {
    demoMode = !demoMode;
    demoVideo.style.display = demoMode ? 'block' : 'none';
    frameImg.style.display = demoMode ? 'none' : 'block';
    toggleDemoBtn.textContent = demoMode ? 'Demo: ON' : 'Demo: OFF';
    connectionStatus.textContent = demoMode ? 'Demo Mode' : 'Preview';
    connectionStatus.classList.toggle('status-active', !demoMode);
  });

  uploadInput.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    const url = URL.createObjectURL(f);
    if (f.type.startsWith('image')) {
      demoMode = false; demoVideo.style.display = 'none'; frameImg.src = url; frameImg.style.display = 'block';
      frameImg.onload = () => { frameW = frameImg.naturalWidth || frameW; frameH = frameImg.naturalHeight || frameH; updateFrameSize(); };
    } else {
      demoMode = true; demoVideo.style.display = 'block'; frameImg.style.display = 'none'; demoVideo.src = url; demoVideo.play().catch(()=>{});
    }
  });

  async function captureCurrentFrameBlob() {
    const c = document.createElement('canvas');
    const imgEl = demoMode ? demoVideo : frameImg;
    const w = frameW || imgEl.naturalWidth || imgEl.videoWidth || 640;
    const h = frameH || imgEl.naturalHeight || imgEl.videoHeight || 360;
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    try { ctx.drawImage(imgEl, 0, 0, w, h); } catch (e) { console.warn('drawImage failed', e); return null; }
    return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.8));
  }

  function showAlert(a) {
    if (emptyNote) emptyNote.style.display = 'none';
    const div = document.createElement('div'); div.className = 'alert-card';
    const thumb = document.createElement('img'); thumb.className = 'thumb';
    thumb.src = a.thumb ? 'data:image/jpeg;base64,' + a.thumb : 'assets/sample-frame.jpg';
    thumb.alt = a.label || 'alert';
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.innerHTML = `<div class="alert-title">${a.label}</div><div class="small muted">${new Date(a.timestamp||Date.now()).toLocaleString()}</div><div class="small">Conf: ${(a.conf*100||0).toFixed(1)}%</div>`;
    div.appendChild(thumb); div.appendChild(meta); alertsList.prepend(div);
    div.animate([{opacity:0, transform:'translateY(8px)'},{opacity:1, transform:'translateY(0)'}], {duration:280, easing:'ease-out'});
  }

  sendFrameBtn.addEventListener('click', async () => {
    if (!BACKEND_REST_URL) { alert('No REST endpoint configured. Use demo mode.'); return; }
    const now = Date.now(); if (now - lastSent < 500) return; lastSent = now;
    const blob = await captureCurrentFrameBlob(); if (!blob) { alert('Could not capture frame'); return; }
    const form = new FormData(); form.append('frame', blob, 'frame.jpg');
    try {
      const res = await fetch(BACKEND_REST_URL, { method:'POST', body: form });
      if (!res.ok) throw new Error('bad response ' + res.status);
      const json = await res.json(); frameW = json.frame_w || frameW; frameH = json.frame_h || frameH;
      drawBoxes(json.detections || []); (json.alerts || []).forEach(showAlert);
    } catch (err) { console.error(err); alert('Send failed: ' + (err.message || err)); }
  });

  wsBtn.addEventListener('click', () => {
    if (!BACKEND_WS_URL) { alert('No WS URL configured'); return; }
    if (ws && ws.readyState === WebSocket.OPEN) { ws.close(); ws = null; wsBtn.textContent = 'Connect WebSocket'; connectionStatus.textContent = 'Disconnected'; connectionStatus.classList.remove('status-active'); return; }
    ws = new WebSocket(BACKEND_WS_URL);
    ws.onopen = () => { wsBtn.textContent = 'Disconnect WS'; connectionStatus.textContent = 'Connected'; connectionStatus.classList.add('status-active'); };
    ws.onmessage = (ev) => { try {
      const data = JSON.parse(ev.data);
      if (data.frame) { demoMode = false; demoVideo.style.display = 'none'; frameImg.style.display = 'block'; frameImg.src = 'data:image/jpeg;base64,' + data.frame; }
      frameW = data.frame_w || frameW; frameH = data.frame_h || frameH; drawBoxes(data.detections || []); (data.alerts || []).forEach(showAlert);
    } catch (e) { console.error('WS parse', e); } };
    ws.onerror = (e) => console.error('WS err', e);
    ws.onclose = () => { wsBtn.textContent = 'Connect WebSocket'; connectionStatus.textContent = 'Disconnected'; connectionStatus.classList.remove('status-active'); };
  });

  function demoFakeDetection() {
    if (!demoMode) return;
    const w = frameW || demoVideo.videoWidth || 640; const h = frameH || demoVideo.videoHeight || 360;
    const x1 = Math.random() * (w * 0.6); const y1 = Math.random() * (h * 0.6);
    const x2 = x1 + (50 + Math.random()*150); const y2 = y1 + (30 + Math.random()*120);
    const det = { xyxy: [x1,y1,x2,y2], conf: (0.5 + Math.random()*0.45), label: 'pothole' };
    drawBoxes([det]); showAlert({ label: det.label, conf: det.conf, timestamp: new Date().toISOString(), thumb: null});
  }
  setInterval(()=> { if (demoMode) demoFakeDetection(); }, 5000);
  toggleDemoBtn.textContent = 'Demo: ON';
})();
