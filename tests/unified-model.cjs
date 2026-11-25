const fs=require('fs'),vm=require('vm'),assert=require('assert');
const app=fs.readFileSync(require('path').join(__dirname,'../app.js'),'utf8');
const nms=app.slice(app.indexOf('function suppressToggleDuplicates'),app.indexOf('let lastToggleScoreCheck'));
let controls,interval,runCount=0,published=[],kind,unloaded=false;
const context={setLineDash(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},arc(){},fill(){},fillText(){},clearRect(){},scale(){},save(){},restore(){},translate(){},rotate(){},strokeRect(){},fillRect(){},drawImage(){},getImageData(){return {data:new Uint8Array(960*960*4)}}};
function basic(){return {hidden:false,style:{},value:'0',checked:false,replaceChildren(){},append(){},addEventListener(){}}}
function element(type){const e={...basic(),getContext:()=>context,setAttribute(){},after(){},querySelectorAll(){return this.inputs},querySelector(q){return this.items[q]},set innerHTML(value){
 this.inputs=[{files:[]},{checked:true},{value:'.25'},{checked:true}];this.items={};
 for(const q of ['.stack-summary','button','[role="status"]','.vision-area','.vision-pick','.vision-auto','.vision-apply','.vision-undo','.vision-status','.vision-clear'])this.items[q]=basic();
 controls=this;
 }};return e;}
const source={videoWidth:1920,videoHeight:1080,clientWidth:960,clientHeight:540,readyState:2,currentTime:1,paused:true,addEventListener(){},classList:{remove(){}}};
let dims=[1,8,3],values;
function output(channels){const a=new Float32Array(channels*3);for(let i=0;i<3;i++){a[i]=100+300*i;a[3+i]=450;a[6+i]=40;a[9+i]=40;a[(4+i)*3+i]=.9;}return a;}
values=output(8);
let expectedSize=960;
const session={inputNames:['images'],outputNames:['output'],run:async(feed)=>{runCount++;if(feed.images.dims[2]!==expectedSize)throw Error('Wrong input size');return {output:{dims,data:values,dispose(){}}}},release:async()=>{}};
const runtime={env:{wasm:{}},Tensor:class{constructor(type,data,dims){this.dims=dims}dispose(){}},InferenceSession:{create:async()=>session}};
const sandbox={console,Float32Array,Uint8Array,Math,Number,Object,String,performance:{now:()=>10000},window:{devicePixelRatio:1,RoboCoachVision:{clear(){},loaded(v){kind=v},publish(v){published=v},unload(){unloaded=true}},RoboCoachLiveScore:{}},document:{hidden:false,createElement:element,addEventListener(){}},byId:()=>({parentElement:{append(){}},after(){},addEventListener(){}}),scorePanel:{hidden:false,addEventListener(){}},
 scoringVideo:()=>source,frozenLiveFrame:{hidden:true},video:source,liveTabVideo:source,modelFrame:element('canvas'),setPen(){},toggleFaceOffset(){},
 loadToggleRuntime:async()=>runtime,runtimeBase:'test',ResizeObserver:class{observe(){}},MutationObserver:class{observe(){}},setInterval:f=>{interval=f},setTimeout};
vm.createContext(sandbox);vm.runInContext(fs.readFileSync(require('path').join(__dirname,'../override-scoring.js'),'utf8'),sandbox);vm.runInContext(nms+fs.readFileSync(require('path').join(__dirname,'../vision-model.js'),'utf8'),sandbox);
async function load(){controls.inputs[0].files=[{name:'best.onnx',arrayBuffer:async()=>new ArrayBuffer(1)}];await controls.inputs[0].onchange();await new Promise(r=>setImmediate(r));}
(async()=>{
await load();assert.equal(kind,'combined');assert.equal(published.length,1);assert.match(controls.items['[role="status"]'].textContent,/1 Toggles · 1 pin halves · 1 goals/);assert.equal(runCount,2);
controls.items.button.onclick();assert(unloaded);
expectedSize=640;dims=[1,6,1];values=new Float32Array([320,320,60,30,.9,0]);await load();assert.equal(kind,'toggle-only');assert.equal(published.length,1);assert.match(controls.items['[role="status"]'].textContent,/toggle-only/);
controls.items.button.onclick();expectedSize=960;dims=[1,7,1];values=new Float32Array([480,480,40,40,.9,.1,0]);await load();assert.equal(kind,'pins-goals');assert.equal(published.length,0);
console.log('PASS: one session and one inference per frame; combined three-class routing; 640 input fallback; legacy Toggle-only and pins/goals routing; shared unload.');
})().catch(e=>{console.error(e);process.exitCode=1});

