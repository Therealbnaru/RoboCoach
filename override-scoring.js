// V5RC Override v2.1: SC3-SC7 and RSC3. Counts must be verified visible, placed halves.
(() => {
  function calculate(areas, {mode='match',phase='match',auton=''}={}) {
    const score={red:0,blue:0,skills:0};
    const count=n=>Number.isFinite(Number(n))?Math.max(0,Math.floor(Number(n))):0;
    areas.forEach((area,i)=>{
      const [red,blue,yellow,rr,br]=area.counts.map(count);
      const r=rr||0,b=br||0,midfield=i===4 || area.midfield===true;
      if(mode==='skills') {
        score.skills+=5*((midfield || area.quadrant==='red'?red:0)+(midfield || area.quadrant==='blue'?blue:0));
        const robot=midfield && r>0;
        const owned=midfield?robot:!!area.quadrant && area.toggle===area.quadrant;
        if(owned)score.skills+=10*yellow;
        if(robot)score.skills+=8;
      } else {
        score.red+=5*red;score.blue+=5*blue;
        if(phase!=='autonomous' && midfield){score.red+=8*Math.min(2,r);score.blue+=8*Math.min(2,b);}
        const owner=midfield?(phase==='autonomous'||r===b?'':r>b?'red':'blue'):area.toggle;
        if(owner==='red'||owner==='blue')score[owner]+=10*yellow;
      }
    });
    if(mode==='match'&&phase!=='autonomous') {
      if(auton==='tie'){score.red+=6;score.blue+=6;}
      else if(auton==='red'||auton==='blue')score[auton]+=12;
    }
    return score;
  }
  globalThis.OverrideScoring={calculate};
  function aggregate(stacks,anchors) {
    const matched=new Map(),blocked=new Set();
    for(const group of stacks.goals) {
      const options=anchors.map(a=>({anchor:a,distance:Math.hypot(a.x-group.goal.x,a.y-group.goal.y)}))
        .filter(o=>o.distance<Math.max(.035,o.anchor.width*.7)).sort((a,b)=>a.distance-b.distance);
      if(!options.length)continue;
      if(options[1]&&options[1].distance-options[0].distance<.015){options.forEach(o=>blocked.add(o.anchor.area));continue;}
      const anchor=options[0].anchor;
      if(matched.has(anchor))blocked.add(anchor.area);
      else matched.set(anchor,group);
    }
    const areas=new Map(),held=[];
    for(const index of new Set(anchors.map(a=>a.area))) {
      const selected=anchors.filter(a=>a.area===index),groups=selected.map(a=>matched.get(a));
      if(blocked.has(index)||groups.some(g=>!g||!g.pins.length||g.counts.unknown>0)) {held.push(index);continue;}
      const totals={red:0,blue:0,yellow:0};
      for(const g of groups)for(const color of Object.keys(totals))totals[color]+=g.counts[color];
      areas.set(index,totals);
    }
    return {areas,held};
  }
  globalThis.RoboCoachVisionScoring={aggregate};
})();

