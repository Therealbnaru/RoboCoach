// Separate two-class OBB preview; detections never change scoring counts.
(() => {
  const controls = document.createElement('details');
  controls.className = 'toggle-model';
  controls.open = true;
  controls.innerHTML = `<summary>Pins and goals model</summary>
    <p class="hint">Load your 960×960 ONNX model (class 0: pin half, class 1: goal). Blue boxes show pins; green boxes show goals. Counts are detections, not scoring totals.</p>
    <label>Pins and goals ONNX <input type="file" accept=".onnx"></label>
    <label class="toggle-dev"><input type="checkbox" checked> Show boxes</label>
    <label>Confidence <input type="range" min="0.05" max="0.9" step="0.05" value="0.25"></label>
    <button type="button" disabled>Unload pins and goals</button>
    <p class="hint" role="status">No pins and goals model loaded.</p>`;
  byId('toggleModelControls').parentElement.append(controls);
  const [file, visible, threshold] = controls.querySelectorAll('input');
  const stop = controls.querySelector('button');
  const status = controls.querySelector('[role="status"]');
  const overlay = document.createElement('canvas');
  overlay.setAttribute('aria-hidden', 'true');
  Object.assign(overlay.style, {position:'absolute', inset:'0', width:'100%', height:'100%', pointerEvents:'none', zIndex:'1'});
  byId('toggleDebugOverlay').after(overlay);
  const input = document.createElement('canvas');
  input.width = input.height = 960;
  const ctx = input.getContext('2d', {willReadFrequently:true});
  let model, busy = false, loading = false, generation = 0, boxes = [], lastRun = -Infinity;
  function clear() { boxes = []; overlay.getContext('2d').clearRect(0,0,overlay.width,overlay.height); }
  function draw() {
    const source = scoringVideo();
    overlay.hidden = !visible.checked || scorePanel.hidden || !frozenLiveFrame.hidden;
    const w = source?.clientWidth, h = source?.clientHeight;
    if (overlay.hidden || !w || !h || !source.videoWidth) { clear(); return; }
    const ratio = window.devicePixelRatio || 1;
    overlay.width = Math.round(w*ratio); overlay.height = Math.round(h*ratio);
    const c = overlay.getContext('2d'); c.scale(ratio,ratio); c.lineWidth = 2;
    const scale = Math.min(w/source.videoWidth,h/source.videoHeight);
    const cw = source.videoWidth*scale, ch = source.videoHeight*scale;
    for (const b of boxes) {
      c.save(); c.translate((w-cw)/2+b.x*cw,(h-ch)/2+b.y*ch);
      c.rotate(b.angle); c.strokeStyle = b.classId === 0 ? '#3388ff' : '#38ef68';
      c.strokeRect(-b.width*cw/2,-b.height*ch/2,b.width*cw,b.height*ch); c.restore();
    }
  }
  async function infer(session, runtime, pixels) {
    const tensor = new runtime.Tensor('float32', pixels, [1,3,960,960]);
    let outputs;
    try {
      outputs = await session.run({[session.inputNames[0]]:tensor});
      const output = outputs[session.outputNames[0]];
      const dims = [...output.dims];
      if (dims.length !== 3 || dims[0] !== 1 || dims[1] !== 7 || dims[2] < 1)
        throw new Error('Expected raw two-class OBB [1,7,N], received ['+dims+']. Export with end2end=False and nms=False.');
      return {dims, data:Float32Array.from(output.data)};
    } finally {
      tensor.dispose();
      if (outputs) Object.values(outputs).forEach(t => t.dispose());
    }
  }
  file.onchange = async () => {
    const selected = file.files[0]; file.value = '';
    if (!selected) return;
    loading = true; file.disabled = stop.disabled = true;
    status.textContent = 'Loading pins and goals…';
    let session;
    try {
      const runtime = await loadToggleRuntime();
      runtime.env.wasm.wasmPaths = runtimeBase; runtime.env.wasm.numThreads = 1;
      session = await runtime.InferenceSession.create(await selected.arrayBuffer(), {executionProviders:['wasm']});
      await infer(session,runtime,new Float32Array(3*960*960));
      const old = model;
      model = {session,runtime}; session = undefined; generation++; clear();
      // An old inference may still be finishing. Dispose after it releases its lock.
      if (old) retire(old);
      status.textContent = selected.name+' loaded. Open a video or share a tab to preview.';
    } catch (error) { status.textContent = 'Could not load: '+String(error.message).slice(0,250); }
    finally { if (session) await session.release(); loading = false; file.disabled = false; stop.disabled = !model; check(); }
  };
  function retire(old) {
    if (busy) { setTimeout(() => retire(old),100); return; }
    old.session.release().catch(console.error);
  }
  stop.onclick = () => {
    const old = model; model = undefined; generation++; clear(); stop.disabled = true;
    status.textContent = 'Pins and goals unloaded.'; if (old) retire(old);
  };
  visible.onchange = () => { generation++; clear(); draw(); check(); };
  threshold.oninput = () => { generation++; clear(); lastRun = -Infinity; check(); };
  async function check() {
    const source = scoringVideo();
    if (busy || loading || !model || !visible.checked || scorePanel.hidden || document.hidden ||
        !frozenLiveFrame.hidden || !source || source.readyState < 2 || source.seeking || performance.now()-lastRun < 1000) return;
    busy = true; lastRun = performance.now();
    const active = model, token = generation, time = source.currentTime;
    try {
      const width = source.videoWidth, height = source.videoHeight;
      const scale = Math.min(960/width,960/height), dx = (960-width*scale)/2, dy = (960-height*scale)/2;
      ctx.fillStyle = '#727272'; ctx.fillRect(0,0,960,960); ctx.drawImage(source,dx,dy,width*scale,height*scale);
      const rgba = ctx.getImageData(0,0,960,960).data, plane = 960*960, pixels = new Float32Array(plane*3);
      for (let i=0;i<plane;i++) for (let channel=0;channel<3;channel++) pixels[i+plane*channel] = rgba[4*i+channel]/255;
      const {data,dims} = await infer(active.session,active.runtime,pixels);
      if (token !== generation || model !== active || source !== scoringVideo() || scorePanel.hidden || source.seeking ||
          (source.paused && source.currentTime !== time)) return;
      const count = dims[2], candidates = [];
      for (let i=0;i<count;i++) {
        const classId = data[4*count+i] >= data[5*count+i] ? 0 : 1;
        const confidence = data[(4+classId)*count+i];
        const b = {classId,confidence,x:(data[i]-dx)/(width*scale),y:(data[count+i]-dy)/(height*scale),
          width:data[2*count+i]/(width*scale),height:data[3*count+i]/(height*scale),angle:data[6*count+i]};
        if (Object.values(b).every(Number.isFinite) && confidence >= Number(threshold.value) &&
            b.x>=0 && b.x<=1 && b.y>=0 && b.y<=1 && b.width>0 && b.height>0) candidates.push(b);
      }
      boxes = [0,1].flatMap(id => suppressToggleDuplicates(candidates.filter(b=>b.classId===id),width,height));
      draw();
      status.textContent = boxes.filter(b=>b.classId===0).length+' pin halves · '+boxes.filter(b=>b.classId===1).length+
        ' goals · Confidence '+Number(threshold.value).toFixed(2)+'. Preview only; scoring counts stay manual.';
    } catch (error) {
      if (token === generation) { clear(); status.textContent = 'Preview failed: '+String(error.message).slice(0,200); }
    } finally { busy = false; }
  }
  const resize = new ResizeObserver(draw);
  for (const source of [video,liveTabVideo]) {
    resize.observe(source);
    for (const event of ['loadeddata','seeked','play','pause','emptied']) source.addEventListener(event,()=>{
      generation++; clear(); lastRun = -Infinity; check();
    });
    source.addEventListener('seeking',()=>{generation++;clear();});
  }
  new MutationObserver(()=>{generation++;clear();lastRun=-Infinity;check();}).observe(scorePanel,{attributes:true,attributeFilter:['hidden']});
  setInterval(check,1000);
})();

