// Conservative, frame-local hypotheses. Geometry does not prove scoring eligibility.
(() => {
  function extent(box, width, height) {
    const c=Math.abs(Math.cos(box.angle)),s=Math.abs(Math.sin(box.angle));
    return {x:box.x*width,y:box.y*height,w:c*box.width*width+s*box.height*height,
      h:s*box.width*width+c*box.height*height};
  }
  function match(boxes,width,height) {
    const goals=boxes.filter(b=>b.classId===1).sort((a,b)=>a.x-b.x || a.y-b.y)
      .map((goal,i)=>({id:'G'+(i+1),goal,pins:[],counts:{red:0,blue:0,yellow:0,unknown:0}}));
    const pending=new Set(boxes.filter(b=>b.classId===0));
    const ambiguous=new Set();
    for(let round=0;round<boxes.length;round++) {
      const edges=[];
      for(const pin of pending) {
        if(ambiguous.has(pin)) continue;
        const p=extent(pin,width,height),options=[];
        for(const group of goals) {
          const base=extent(group.goal,width,height),last=group.pins.at(-1),anchor=last?extent(last,width,height):base;
          // Build upwards from a base, not by accepting every box in a tall rectangle.
          const rise=anchor.y-p.y;
          if(p.y>=base.y || rise<Math.max(2,p.h*.35)) continue;
          const gap=rise-(anchor.h+p.h)/2;
          if(gap>Math.max(p.h,anchor.h)*1.8 || gap < -Math.min(p.h,anchor.h)*.55) continue;
          if(last && (p.h/anchor.h<.45 || p.h/anchor.h>2.2)) continue;
          let slope=0;
          if(group.pins.length>=2) {
            const a=extent(group.pins.at(-2),width,height);
            slope=Math.max(-.35,Math.min(.35,(anchor.x-a.x)/Math.max(1,a.y-anchor.y)));
          }
          const drift=Math.abs(p.x-(anchor.x+slope*rise));
          const allowance=Math.max(p.w,anchor.w)*.48+rise*.22;
          if(drift>allowance) continue;
          options.push({group,pin,cost:drift/allowance+Math.max(0,gap)/Math.max(p.h,anchor.h)*.5});
        }
        options.sort((a,b)=>a.cost-b.cost);
        if(options.length>1 && options[1].cost-options[0].cost<.25) {ambiguous.add(pin);continue;}
        if(options.length) edges.push(options[0]);
      }
      if(!edges.length) break;
      // Recompute after each attachment so one chain cannot jump over a nearer half.
      edges.sort((a,b)=>a.cost-b.cost);
      const chosen=edges[0];chosen.group.pins.push(chosen.pin);pending.delete(chosen.pin);
    }
    for(const group of goals) for(const pin of group.pins) group.counts[pin.color || 'unknown']++;
    return {goals,unmatched:[...pending],ambiguous:[...ambiguous]};
  }
  function color(box,rgba,size,geometry) {
    const votes={red:0,blue:0,yellow:0};let total=0;
    const c=Math.cos(box.angle),s=Math.sin(box.angle);
    for(let row=0;row<9;row++) for(let col=0;col<9;col++) {
      const dx=(col/8-.5)*box.width*geometry.width*.7;
      const dy=(row/8-.5)*box.height*geometry.height*.7;
      const x=Math.round((box.x*geometry.width+c*dx-s*dy)*geometry.scale+geometry.dx);
      const y=Math.round((box.y*geometry.height+s*dx+c*dy)*geometry.scale+geometry.dy);
      if(x<0||y<0||x>=size||y>=size)continue;
      const i=(y*size+x)*4,r=rgba[i]/255,g=rgba[i+1]/255,b=rgba[i+2]/255;
      const hi=Math.max(r,g,b),lo=Math.min(r,g,b),delta=hi-lo;total++;
      if(hi<.18 || !delta || delta/hi<.22)continue;
      let hue=hi===r?60*((g-b)/delta%6):hi===g?60*((b-r)/delta+2):60*((r-g)/delta+4);
      if(hue<0)hue+=360;
      if(hue<=24||hue>=340)votes.red++;
      else if(hue>=36&&hue<=80)votes.yellow++;
      else if(hue>=175&&hue<=270)votes.blue++;
    }
    const ranked=Object.entries(votes).sort((a,b)=>b[1]-a[1]),colored=Object.values(votes).reduce((a,b)=>a+b,0);
    return total>=20 && colored/total>=.18 && ranked[0][1]/Math.max(1,colored)>=.65 ? ranked[0][0] : 'unknown';
  }
  globalThis.RoboCoachStacks={match,color};
})();


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
    <label class="toggle-dev"><input type="checkbox" checked> Show stack matching</label>
    <p class="hint">Stack links are estimates. Dashed pin boxes are unmatched; ? means unclear color. Goal IDs apply to the current frame.</p>
    <div class="stack-summary" aria-label="Estimated stacks"></div>
    <button type="button" disabled>Unload pins and goals</button>
    <p class="hint" role="status">No pins and goals model loaded.</p>`;
  byId('toggleModelControls').parentElement.append(controls);
  const [file, visible, threshold] = controls.querySelectorAll('input');
  const matching = controls.querySelectorAll('input')[3];
  const summary = controls.querySelector('.stack-summary');
  const stop = controls.querySelector('button');
  const status = controls.querySelector('[role="status"]');
  const overlay = document.createElement('canvas');
  overlay.setAttribute('aria-hidden', 'true');
  Object.assign(overlay.style, {position:'absolute', inset:'0', width:'100%', height:'100%', pointerEvents:'none', zIndex:'1'});
  byId('toggleDebugOverlay').after(overlay);
  const input = document.createElement('canvas');
  input.width = input.height = 960;
  const ctx = input.getContext('2d', {willReadFrequently:true});
  let model, busy = false, loading = false, generation = 0, boxes = [], stacks, lastRun = -Infinity;
  function clear() { boxes = []; stacks = undefined; summary.replaceChildren(); overlay.getContext('2d').clearRect(0,0,overlay.width,overlay.height); }
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
      if (matching.checked && b.classId === 0 && stacks?.unmatched.includes(b)) c.setLineDash([4,4]);
      c.rotate(b.angle); c.strokeStyle = b.classId === 0 ? '#3388ff' : '#38ef68';
      c.strokeRect(-b.width*cw/2,-b.height*ch/2,b.width*cw,b.height*ch); c.restore();
    }
    if (matching.checked && stacks) {
      const px=b=>(w-cw)/2+b.x*cw, py=b=>(h-ch)/2+b.y*ch;
      c.font='12px system-ui';
      for (const group of stacks.goals) {
        c.strokeStyle='#b9f47e88'; c.lineWidth=1;
        let previous=group.goal;
        for (const pin of group.pins) {
          c.beginPath();c.moveTo(px(previous),py(previous));c.lineTo(px(pin),py(pin));c.stroke();previous=pin;
          c.beginPath();c.arc(px(pin),py(pin),3,0,Math.PI*2);
          c.fillStyle={red:'#ff707c',blue:'#6bc6ff',yellow:'#ffe263',unknown:'#aab3bf'}[pin.color];c.fill();
        }
        const x=Math.max(0,Math.min(w-35,px(group.goal))), y=Math.max(14,py(group.goal));
        c.fillStyle='#12171e';c.fillRect(x,y-14,30,17);c.fillStyle='#d7ffe4';c.fillText(group.id,x+3,y-1);
      }
    }
  }
  function describeStacks() {
    summary.replaceChildren();
    if (!stacks) return;
    for (const group of stacks.goals) {
      const row=document.createElement('p'), n=group.counts;
      row.className='hint';row.style.margin='5px 0';
      row.textContent=group.id+': '+(group.pins.length
        ? n.yellow+' yellow · '+n.red+' red · '+n.blue+' blue · '+n.unknown+' unknown'
        : 'No matched halves (empty or missed/occluded)');
      summary.append(row);
    }
    const row=document.createElement('p');row.className='hint';
    row.textContent=stacks.unmatched.length+' unmatched halves, including '+stacks.ambiguous.length+' ambiguous. No score changes.';
    summary.append(row);
  }
  matching.onchange=()=>{draw();summary.hidden=!matching.checked;};
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
      for (const b of boxes) if (b.classId===0)
        b.color=RoboCoachStacks.color(b,rgba,960,{width,height,scale,dx,dy});
      stacks=RoboCoachStacks.match(boxes,width,height);
      describeStacks();
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

