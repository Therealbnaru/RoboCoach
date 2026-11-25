const fs=require('fs'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(require('path').join(__dirname,'../app.js'),'utf8');
const part=src.slice(src.indexOf('const modelFrame = document.createElement'),src.indexOf('// Rotated polygon overlap'));
const anchor={x:.5,y:.5,pendingColor:'red',pendingCount:1};let checks=0,last;
const scope={document:{createElement(){return {}}},window:{},trackedToggles:new Map([[0,anchor]]),
stopToggleTracking(){scope.trackedToggles.clear()},toggleModel:undefined,unifiedTogglePoints:undefined,trackingGeneration:0,
debugOverlay:{hidden:true},toggleDevMode:{checked:true},byId(){return {}},modelStatus:{},debugDetections:[],drawToggleDebug(){},checkToggleFrame(fresh){checks++;last=fresh}};
vm.createContext(scope);vm.runInContext(part,scope);
scope.window.RoboCoachVision.loaded('combined');scope.trackedToggles.set(0,anchor);
scope.window.RoboCoachVision.publish([{x:.51,y:.5,confidence:.9,width:.2,height:.04,angle:0}]);assert.equal(checks,1);assert.equal(last,true);
scope.window.RoboCoachVision.clear();assert.equal(anchor.pendingCount,0);assert.equal(scope.debugDetections.length,0);
scope.window.RoboCoachVision.loaded('pins-goals');scope.window.RoboCoachVision.publish([]);assert.equal(checks,1);
scope.window.RoboCoachVision.unload();assert.equal(scope.toggleModel,undefined);
assert(!src.includes('detectTogglePoints('));assert(!src.includes('InferenceSession.create'));
console.log('PASS: combined Toggle bridge, assignment routing, stale reading reset, legacy pins-only isolation, shared unload, no second model session in app.');

