#!/usr/bin/env node
'use strict';

/*
  五道方 V2.3 深度训练器 V6.4（Gen5 修复搜索 · 相位抑制战术 · 共享双池筛选 · 深度4独立终审）

  V6.4 针对 V6.3 终审结果做定向修复：
  - V6.3 的“威胁成型35%”在深度4关键对比池只有47.5%，随机池51.7%，总分49.6%。
  - 说明新棋理并非完全无效，但在摆子/过渡阶段过早改变许多接近五五开的选择。
  - V6.4 对 threat/fork/constraint 做相位抑制：摆子阶段55%，满盘先掐75%，掐子90%，正常走棋100%。
    Gen4 的三个新权重为0，因此正式 Gen4 棋力不会被偷偷改变。
  - 候选围绕历史上最有希望的“战术均衡35%”与“威胁成型35%”做局部插值与解耦搜索，
    不重新大幅拟合，避免参数乱跳。
  - 第一阶段用 V6.3 失败关键局面 + 新分歧局面做深度4老师考试；
    第二、三阶段使用所有候选共享的50/50关键池+随机池做深度4实战筛选，避免候选各考各的题。
  - 最后只让筛出的单一冠军参加全新 Seed 的120盘深度4独立终审。
  - 晋级标准不降低：总得分率>=55%，且关键池、随机池都>=50%，才自动写入 Gen5。
*/

import fs from 'node:fs';

const N=5;
const idx=(r,c)=>r*N+c;
const rc=i=>[Math.floor(i/N),i%N];
const inb=(r,c)=>r>=0&&r<N&&c>=0&&c<N;
const coord=i=>String.fromCharCode(65+Math.floor(i/N))+(i%N+1);

const T3=[
  [idx(0,2),idx(1,1),idx(2,0)],
  [idx(0,2),idx(1,3),idx(2,4)],
  [idx(2,0),idx(3,1),idx(4,2)],
  [idx(2,4),idx(3,3),idx(4,2)]
];
const T4=[
  [idx(0,1),idx(1,2),idx(2,3),idx(3,4)],
  [idx(0,3),idx(1,2),idx(2,1),idx(3,0)],
  [idx(1,0),idx(2,1),idx(3,2),idx(4,3)],
  [idx(1,4),idx(2,3),idx(3,2),idx(4,1)]
];
const TSQ=[];
for(let r=0;r<4;r++)for(let c=0;c<4;c++)TSQ.push([idx(r,c),idx(r,c+1),idx(r+1,c+1),idx(r+1,c)]);
const TDR=[
  [idx(0,0),idx(1,1),idx(2,2),idx(3,3),idx(4,4)],
  [idx(0,4),idx(1,3),idx(2,2),idx(3,1),idx(4,0)]
];
const TLI=[];
for(let r=1;r<=3;r++)TLI.push([0,1,2,3,4].map(c=>idx(r,c)));
for(let c=1;c<=3;c++)TLI.push([0,1,2,3,4].map(r=>idx(r,c)));
const ALLT=[
  ...TSQ.map(c=>({type:'一方',score:1,cells:c})),
  ...T3.map(c=>({type:'三步',score:1,cells:c})),
  ...T4.map(c=>({type:'四步',score:1,cells:c})),
  ...TDR.map(c=>({type:'五龙',score:2,cells:c})),
  ...TLI.map(c=>({type:'一溜',score:2,cells:c}))
];

function sameCellsContained(a,b){return a.every(x=>b.includes(x));}
function rawPatterns(board,p){
  const mine=a=>a.every(i=>board[i]&&board[i].p===p),out=[],li=TLI.filter(mine);
  for(const a of TSQ)if(mine(a))out.push({type:'一方',score:1,cells:a});
  for(const a of TDR)if(mine(a))out.push({type:'五龙',score:2,cells:a});
  for(const a of li)out.push({type:'一溜',score:2,cells:a});
  const fours=T4.filter(mine);
  for(const a of fours)if(!li.some(L=>sameCellsContained(a,L)))out.push({type:'四步',score:1,cells:a});
  const threes=T3.filter(mine);
  for(const a of threes)if(!li.some(L=>sameCellsContained(a,L))&&!fours.some(L=>sameCellsContained(a,L)))out.push({type:'三步',score:1,cells:a});
  return out;
}
function sigOf(board,pat){return pat.type+'@'+pat.cells.join('.')+'#'+pat.cells.map(i=>board[i]?.id||0).join('-');}
function protectedSet(board,p){const s=new Set();rawPatterns(board,p).forEach(q=>q.cells.forEach(i=>s.add(i)));return s;}
function newPatterns(s,p){const cl=new Set(s.claimed[p]);return rawPatterns(s.board,p).filter(q=>!cl.has(sigOf(s.board,q)));}
function clone(s){return{
  board:s.board.map(x=>x?{p:x.p,id:x.id}:null),
  nextId:{1:s.nextId[1],2:s.nextId[2]},
  claimed:{1:[...s.claimed[1]],2:[...s.claimed[2]]},
  phase:s.phase,turn:s.turn,bonusLeft:s.bonusLeft,captureLeft:s.captureLeft,
  openingStage:s.openingStage,winner:s.winner||0,winReason:s.winReason||''
};}
function count(board,p){let n=0;for(const x of board)if(x?.p===p)n++;return n;}
function legalMoves(board,p){
  const out=[];
  for(let i=0;i<25;i++)if(board[i]?.p===p){
    const[r,c]=rc(i);
    for(const[dr,dc]of[[1,0],[-1,0],[0,1],[0,-1]]){
      const r2=r+dr,c2=c+dc;
      if(inb(r2,c2)&&!board[idx(r2,c2)])out.push({type:'move',from:i,to:idx(r2,c2)});
    }
  }
  return out;
}
function looseTargets(board,target){
  const prot=protectedSet(board,target),a=[];
  for(let i=0;i<25;i++)if(board[i]?.p===target&&!prot.has(i))a.push(i);
  return a;
}
function terminal(s){
  if(s.winner)return;
  if(count(s.board,1)===0){s.winner=2;s.winReason='captured';s.phase='gameover';return;}
  if(count(s.board,2)===0){s.winner=1;s.winReason='captured';s.phase='gameover';return;}
  if(s.phase==='move'&&legalMoves(s.board,s.turn).length===0){
    s.winner=3-s.turn;s.winReason='stuck';s.phase='gameover';
  }
}
function actions(s){
  if(s.winner)return[];
  if(s.phase==='place'){const a=[];for(let i=0;i<25;i++)if(!s.board[i])a.push({type:'place',to:i});return a;}
  if(s.phase==='opening'){
    const t=looseTargets(s.board,3-s.turn);
    return t.length?t.map(i=>({type:'capture',to:i,opening:true})):[{type:'pass',opening:true}];
  }
  if(s.phase==='move')return legalMoves(s.board,s.turn);
  if(s.phase==='capture'){
    const t=looseTargets(s.board,3-s.turn);
    return t.length?t.map(i=>({type:'capture',to:i})):[{type:'pass'}];
  }
  return[];
}
function apply(s0,a){
  const s=clone(s0),p=s.turn;
  if(a.type==='place'){
    if(s.bonusLeft>0)s.bonusLeft--;
    s.board[a.to]={p,id:s.nextId[p]++};
    const np=newPatterns(s,p);let g=0;
    for(const q of np){s.claimed[p].push(sigOf(s.board,q));g+=q.score;}
    s.bonusLeft+=g;
    if(s.board.every(Boolean)){s.phase='opening';s.turn=2;s.openingStage=0;s.bonusLeft=0;}
    else if(s.bonusLeft===0)s.turn=3-p;
  }else if(a.type==='capture'&&s.phase==='opening'){
    if(a.to!=null)s.board[a.to]=null;
    if(s.openingStage===0){s.openingStage=1;s.turn=1;}
    else{s.phase='move';s.turn=2;s.openingStage=2;terminal(s);}
  }else if(a.type==='pass'&&s.phase==='opening'){
    if(s.openingStage===0){s.openingStage=1;s.turn=1;}
    else{s.phase='move';s.turn=2;s.openingStage=2;terminal(s);}
  }else if(a.type==='move'){
    s.board[a.to]=s.board[a.from];s.board[a.from]=null;
    const np=newPatterns(s,p);let g=0;
    for(const q of np){s.claimed[p].push(sigOf(s.board,q));g+=q.score;}
    if(g>0&&looseTargets(s.board,3-p).length>0){s.phase='capture';s.captureLeft=g;}
    else{s.phase='move';s.captureLeft=0;s.turn=3-p;terminal(s);}
  }else if(a.type==='capture'&&s.phase==='capture'){
    if(a.to!=null)s.board[a.to]=null;
    s.captureLeft--;
    terminal(s);
    if(!s.winner&&(s.captureLeft<=0||looseTargets(s.board,3-p).length===0)){
      s.captureLeft=0;s.phase='move';s.turn=3-p;terminal(s);
    }
  }else if(a.type==='pass'&&s.phase==='capture'){
    s.captureLeft=0;s.phase='move';s.turn=3-p;terminal(s);
  }
  return s;
}
function newState(){return{
  board:Array(25).fill(null),nextId:{1:1,2:1},claimed:{1:[],2:[]},
  phase:'place',turn:1,bonusLeft:0,captureLeft:0,openingStage:0,winner:0,winReason:''
};}
function repetitionKey(s){
  const board=s.board.map(x=>x?`${x.p}:${x.id}`:'0').join(',');
  const c1=[...s.claimed[1]].sort().join('|');
  const c2=[...s.claimed[2]].sort().join('|');
  return board+`#turn=${s.turn}#phase=${s.phase}#c1=${c1}#c2=${c2}`;
}
function stateKey(s){
  return repetitionKey(s)+`#bonus=${s.bonusLeft}#cap=${s.captureLeft}#open=${s.openingStage}`;
}
function actionText(a){
  if(!a)return'';
  if(a.type==='place')return 'P'+coord(a.to);
  if(a.type==='move')return 'M'+coord(a.from)+'-'+coord(a.to);
  if(a.type==='capture')return 'X'+coord(a.to);
  return 'PASS';
}

function actionZh(t){
  if(!t)return '—';
  if(t==='PASS')return '跳过';
  if(t[0]==='P')return '放 '+t.slice(1);
  if(t[0]==='X')return '掐 '+t.slice(1);
  if(t[0]==='M'){
    const x=t.slice(1).split('-');
    return x[0]+'→'+x[1];
  }
  return t;
}
function newClaimTypes(before,after,p){
  const a=before.claimed[p].length;
  return after.claimed[p].slice(a).map(sig=>String(sig).split('@')[0]);
}
function boardText(board){
  const rows=[];
  for(let r=0;r<5;r++){
    const row=[];
    for(let col=0;col<5;col++){
      const x=board[idx(r,col)];
      row.push(x?(x.p===1?'●':'○'):'·');
    }
    rows.push(String.fromCharCode(65+r)+'  '+row.join('  '));
  }
  return '   1  2  3  4  5\n'+rows.join('\n');
}

const centerW=[0,1,2,1,0,1,3,5,3,1,2,5,8,5,2,1,3,5,3,1,0,1,2,1,0];

function patternPotential(board,p){
  let sc=0;
  for(const t of ALLT){
    let me=0,opp=0;
    for(const i of t.cells){if(board[i]?.p===p)me++;else if(board[i])opp++;}
    if(opp===0){
      const n=t.cells.length;
      if(me===n)sc+=18*t.score;
      else if(me===n-1)sc+=11*t.score;
      else if(me===n-2)sc+=3.5*t.score;
    }
  }
  return sc;
}
function adjacentPlayerOutside(board,p,cell,forbidden){
  const[r,c]=rc(cell);
  for(const[dr,dc]of[[1,0],[-1,0],[0,1],[0,-1]]){
    const r2=r+dr,c2=c+dc;
    if(!inb(r2,c2))continue;
    const j=idx(r2,c2);
    if(board[j]?.p===p&&!forbidden.has(j))return true;
  }
  return false;
}
function tacticalThreatProfile(s,p){
  // “威胁”只统计下一次正常落子/走子真正有机会完成的棋型，避免与旧 potential 完全重复。
  const byCell=new Map();
  let threat=0;
  for(const t of ALLT){
    let me=0,opp=0,empty=-1,empties=0;
    for(const i of t.cells){
      if(s.board[i]?.p===p)me++;
      else if(s.board[i])opp++;
      else{empty=i;empties++;}
    }
    if(opp||empties!==1||me!==t.cells.length-1)continue;
    const forbidden=new Set(t.cells);
    const reachable=s.phase==='place'||adjacentPlayerOutside(s.board,p,empty,forbidden);
    if(!reachable)continue;
    threat+=t.score;
    const arr=byCell.get(empty)||[];
    arr.push(t);byCell.set(empty,arr);
  }

  // “双重威胁”要求同一手落到一个点后同时完成至少两个有效棋型。
  let fork=0;
  for(const [cell,ts] of byCell){
    if(ts.length<2)continue;
    let reachable=s.phase==='place';
    if(!reachable){
      const union=new Set();
      for(const t of ts)for(const i of t.cells)union.add(i);
      reachable=adjacentPlayerOutside(s.board,p,cell,union);
    }
    if(reachable){
      const sum=ts.reduce((z,t)=>z+t.score,0);
      fork+=sum+(ts.length-2)*0.75;
    }
  }
  return{threat,fork};
}
function constraintRisk(board,p){
  // 被完全卡住的子最危险；只有一个出口的子也计入受限风险。
  let blocked=0,oneExit=0;
  for(let i=0;i<25;i++)if(board[i]?.p===p){
    const[r,c]=rc(i);let exits=0;
    for(const[dr,dc]of[[1,0],[-1,0],[0,1],[0,-1]]){
      const r2=r+dr,c2=c+dc;
      if(inb(r2,c2)&&!board[idx(r2,c2)])exits++;
    }
    if(exits===0)blocked++;
    else if(exits===1)oneExit++;
  }
  return blocked*2+oneExit*0.65;
}
function featuresBlack(s){
  const material=count(s.board,1)-count(s.board,2);
  const mobility=legalMoves(s.board,1).length-legalMoves(s.board,2).length;
  const protectedDiff=protectedSet(s.board,1).size-protectedSet(s.board,2).size;
  const patternDiff=
    rawPatterns(s.board,1).reduce((z,q)=>z+q.score,0)-
    rawPatterns(s.board,2).reduce((z,q)=>z+q.score,0);
  const potentialDiff=patternPotential(s.board,1)-patternPotential(s.board,2);
  const t1=tacticalThreatProfile(s,1),t2=tacticalThreatProfile(s,2);
  const threat=t1.threat-t2.threat;
  const fork=t1.fork-t2.fork;
  // 正数表示白方比黑方更受困，因此对黑方有利。
  const constraint=constraintRisk(s.board,2)-constraintRisk(s.board,1);
  let center=0;
  for(let i=0;i<25;i++)if(s.board[i])center+=(s.board[i].p===1?1:-1)*centerW[i];
  return {material,mobility,protected:protectedDiff,pattern:patternDiff,potential:potentialDiff,center,threat,fork,constraint};
}
// 老版本正式基线没有 V6 三个新权重时，默认取 0，保证升级 V6 后 Gen4 本身不会被“偷偷改棋力”。
const OLD_WEIGHT_KEYS=['material','mobility','protected','pattern','potential','center'];
const NEW_WEIGHT_KEYS=['threat','fork','constraint'];
const FALLBACK_BASE_WEIGHTS={material:80,mobility:30,protected:0,pattern:21.2625,potential:5,center:0,threat:0,fork:0,constraint:0};
function loadBaselineWeights(){
  try{
    if(fs.existsSync('data/ai-baseline.json')){
      const x=JSON.parse(fs.readFileSync('data/ai-baseline.json','utf8'));
      const w=x.weights||x.baseline||x;
      const ok=OLD_WEIGHT_KEYS.every(k=>Number.isFinite(Number(w[k])));
      if(ok){
        const out={};
        for(const k of OLD_WEIGHT_KEYS)out[k]=Number(w[k]);
        for(const k of NEW_WEIGHT_KEYS)out[k]=Number.isFinite(Number(w[k]))?Number(w[k]):0;
        return out;
      }
    }
  }catch(err){
    console.warn('[baseline] data/ai-baseline.json 读取失败，使用内置基线：'+err.message);
  }
  return {...FALLBACK_BASE_WEIGHTS};
}
const BASE_WEIGHTS=loadBaselineWeights();
function loadBaselineGeneration(){
  try{
    if(fs.existsSync('data/ai-baseline.json')){
      const x=JSON.parse(fs.readFileSync('data/ai-baseline.json','utf8'));
      const g=Number(x.generation);
      if(Number.isFinite(g)&&g>=1)return Math.floor(g);
    }
  }catch{}
  return 3;
}
const BASE_GENERATION=loadBaselineGeneration();

function evalBlack(s,w=BASE_WEIGHTS){
  if(s.winner)return s.winner===1?1e8:-1e8;
  const f=featuresBlack(s);
  // V6.4：V6.3 证明战术新特征在早期摆子阶段过于积极。
  // Gen4 的 threat/fork/constraint 都为0，所以这个语义变化不会改变正式 Gen4。
  const tacticalScale=s.phase==='place'?0.55:s.phase==='opening'?0.75:s.phase==='capture'?0.90:1.0;
  return f.material*w.material+
         f.mobility*w.mobility+
         f.protected*w.protected+
         f.pattern*w.pattern+
         f.potential*w.potential+
         f.center*w.center+
         tacticalScale*(f.threat*w.threat+f.fork*w.fork+f.constraint*w.constraint);
}
function evalFor(s,ai,w){const v=evalBlack(s,w);return ai===1?v:-v;}

function quickOrderScore(s,a,ai,w){
  const ns=apply(s,a);
  let z=evalFor(ns,ai,w);
  if(a.type==='capture')z+=280;
  if(a.type==='place')z+=centerW[a.to]*4;
  if(a.type==='move'){
    z+=(centerW[a.to]-centerW[a.from])*2;
    if(ns.phase==='capture'&&ns.turn===s.turn)z+=180+ns.captureLeft*50;
  }
  return z;
}
function branchCap(s,depth){
  if(s.phase==='place')return depth>=4?7:9;
  if(s.phase==='move')return depth>=4?9:12;
  if(s.phase==='capture'||s.phase==='opening')return 10;
  return 12;
}
function orderedActions(s,ai,w,depth){
  const aa=actions(s);
  if(aa.length<=1)return aa;
  const max=s.turn===ai;
  aa.sort((a,b)=>{
    const va=quickOrderScore(s,a,ai,w),vb=quickOrderScore(s,b,ai,w);
    return max?vb-va:va-vb;
  });
  return aa.slice(0,branchCap(s,depth));
}

function hashKey(s,depth,ai,wtag){
  return `${stateKey(s)}#d=${depth}#ai=${ai}#w=${wtag}`;
}
function alphabeta(s,depth,alpha,beta,ai,w,ctx){
  ctx.nodes++;
  if((ctx.nodes&63)===0 && Date.now()>=ctx.deadline){
    ctx.aborted=true;
    return evalFor(s,ai,w);
  }
  if(ctx.nodes>=ctx.maxNodes){
    ctx.aborted=true;
    return evalFor(s,ai,w);
  }
  if(s.winner||depth<=0)return evalFor(s,ai,w);
  const k=hashKey(s,depth,ai,ctx.wtag);
  const old=ctx.tt.get(k);
  if(old){
    if(old.flag==='EXACT')return old.v;
    if(old.flag==='LOWER')alpha=Math.max(alpha,old.v);
    else if(old.flag==='UPPER')beta=Math.min(beta,old.v);
    if(alpha>=beta)return old.v;
  }
  const alpha0=alpha,beta0=beta;
  const aa=orderedActions(s,ai,w,depth);
  if(!aa.length)return evalFor(s,ai,w);
  const maximizing=s.turn===ai;
  let best=maximizing?-Infinity:Infinity;
  for(const a of aa){
    const ns=apply(s,a);
    const nd=depth-((ns.winner||ns.turn!==s.turn)?1:0);
    const v=alphabeta(ns,nd,alpha,beta,ai,w,ctx);
    if(maximizing){
      if(v>best)best=v;
      if(best>alpha)alpha=best;
    }else{
      if(v<best)best=v;
      if(best<beta)beta=best;
    }
    if(ctx.aborted||alpha>=beta)break;
  }
  if(!ctx.aborted){
    let flag='EXACT';
    if(best<=alpha0)flag='UPPER';
    else if(best>=beta0)flag='LOWER';
    if(ctx.tt.size<ctx.maxTT)ctx.tt.set(k,{v:best,flag});
  }
  return best;
}

function searchRoot(s,targetDepth,ai,w,wtag='base'){
  const first=orderedActions(s,ai,w,1);
  if(!first.length)return{action:null,ranked:[],nodes:0,score:evalFor(s,ai,w),depth:0,budgetCut:false};

  const maxMs=targetDepth<=2?70:targetDepth===3?150:900;
  const deadline=Date.now()+maxMs;
  const maxNodes=targetDepth<=2?12000:targetDepth===3?30000:180000;
  const maxTT=targetDepth<=2?4000:targetDepth===3?8000:36000;
  let completed=null,totalNodes=0,budgetCut=false;

  for(let depth=1;depth<=targetDepth;depth++){
    const aa=orderedActions(s,ai,w,depth);
    const ctx={nodes:0,tt:new Map(),wtag,deadline,maxNodes,maxTT,aborted:false};
    const ranked=[];
    for(const a of aa){
      const ns=apply(s,a);
      const nd=depth-((ns.winner||ns.turn!==s.turn)?1:0);
      const v=alphabeta(ns,nd,-Infinity,Infinity,ai,w,ctx);
      ranked.push({a,v});
      if(ctx.aborted||Date.now()>=deadline)break;
    }
    totalNodes+=ctx.nodes;
    if(!ctx.aborted && ranked.length===aa.length){
      ranked.sort((x,y)=>y.v-x.v);
      completed={action:ranked[0].a,ranked,score:ranked[0].v,depth};
    }else{
      budgetCut=true;
      break;
    }
    if(Date.now()>=deadline)break;
  }

  if(completed)return{...completed,nodes:totalNodes,budgetCut};
  const fallback=first.map(a=>({a,v:quickOrderScore(s,a,ai,w)})).sort((x,y)=>y.v-x.v);
  return{action:fallback[0].a,ranked:fallback,nodes:totalNodes,score:fallback[0].v,depth:0,budgetCut:true};
}

function mulberry32(seed){
  return function(){
    let t=seed+=0x6D2B79F5;
    t=Math.imul(t^t>>>15,t|1);
    t^=t+Math.imul(t^t>>>7,t|61);
    return((t^t>>>14)>>>0)/4294967296;
  };
}
function weightedPick(items,weights,rng){
  let total=0;for(const w of weights)total+=Math.max(0,w);
  if(total<=0)return items[0];
  let x=rng()*total;
  for(let i=0;i<items.length;i++){
    x-=Math.max(0,weights[i]);
    if(x<=0)return items[i];
  }
  return items[items.length-1];
}
function pickFromSearch(res,rng,explore,state=null,visitMap=null,forceDifferent=false){
  if(!res.ranked.length)return null;
  if(!explore||res.ranked.length===1)return res.ranked[0].a;

  const best=res.ranked[0].v;
  const tol=state?.phase==='place'?220:state?.phase==='move'?160:100;
  let safe=res.ranked.filter((x,i)=>i<5 && best-x.v<=tol);
  if(safe.length<2)return res.ranked[0].a;

  // 只在搜索认为“接近好棋”的候选里做多样化；访问越多的路线，权重越低。
  const sk=state?stateKey(state):'';
  const weights=safe.map((x,i)=>{
    const visits=visitMap?(visitMap.get(sk+'|'+actionText(x.a))||0):0;
    const rankWeight=Math.exp(-0.58*i);
    const novelty=1/(1+0.45*visits);
    let w=rankWeight*novelty;
    if(forceDifferent&&i===0)w*=0.18;
    return w;
  });
  return weightedPick(safe.map(x=>x.a),weights,rng);
}

function parseArgs(){
  const args=process.argv.slice(2);
  const out={games:500,depth:3,seed:20260905,maxActions:5000,tourGames:null};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--games')out.games=Number(args[++i]);
    else if(args[i]==='--depth')out.depth=Number(args[++i]);
    else if(args[i]==='--seed')out.seed=Number(args[++i]);
    else if(args[i]==='--max-actions')out.maxActions=Number(args[++i]);
    else if(args[i]==='--tour-games')out.tourGames=Number(args[++i]);
  }
  if(!Number.isFinite(out.games)||out.games<1)throw new Error('games must be >=1');
  if(![2,3,4].includes(out.depth))throw new Error('depth must be 2, 3, or 4');
  return out;
}
const cfg=parseArgs();

function outcomeBlack(winner,drawReason){
  if(drawReason)return 0;
  if(winner===1)return 1;
  if(winner===2)return -1;
  return 0;
}

function playGame({
  seed,depth,blackWeights,whiteWeights,explore=true,collect=true,
  startState=null,diversityVisits=null
}){
  const rng=mulberry32(seed>>>0);
  let s=startState?clone(startState):newState();
  let n=0,noProgress=0,drawReason='',turnChanges=0,totalNodes=0,budgetCuts=0;
  const seen=new Map(),openingDecisions=[],samples=[],trace=[],lineActions=[];
  let prevTurn=s.turn;

  while(!s.winner&&!drawReason&&n<cfg.maxActions){
    const actor=s.turn;
    const w=actor===1?blackWeights:whiteWeights;
    const wtag=actor===1?'B':'W';

    if(collect&&s.phase==='move'&&samples.length<18&&n%3===0){
      samples.push(featuresBlack(s));
    }

    const res=searchRoot(s,depth,actor,w,wtag);
    totalNodes+=res.nodes;
    if(res.budgetCut)budgetCuts++;
    if(!res.action)break;

    const repeatPressure=(seen.get(repetitionKey(s))||0)>=1 || noProgress>=24;
    const earlyEligible=n<36&&(s.phase==='place'||s.phase==='move');
    const doExplore=explore&&earlyEligible&&(repeatPressure||rng()<0.34);
    const a=pickFromSearch(res,rng,doExplore,s,diversityVisits,repeatPressure);

    if(collect&&n<34){
      openingDecisions.push({
        key:stateKey(s),actor,action:actionText(a),phase:s.phase,
        sequence:[...lineActions],searchScore:Number(res.score.toFixed(2)),searchDepth:res.depth
      });
    }

    if(diversityVisits&&earlyEligible){
      const vk=stateKey(s)+'|'+actionText(a);
      diversityVisits.set(vk,(diversityVisits.get(vk)||0)+1);
    }

    const before=s;
    const claimedBefore=s.claimed[1].length+s.claimed[2].length;
    const ns=apply(s,a);
    const claimedAfter=ns.claimed[1].length+ns.claimed[2].length;
    const formed=newClaimTypes(before,ns,actor);
    const at=actionText(a);

    if(a.type==='capture')noProgress=0;
    else if(a.type==='move'){
      noProgress=claimedAfter>claimedBefore?0:noProgress+1;
    }

    if(collect&&trace.length<42){
      trace.push({
        n:n+1,actor,phase:before.phase,action:at,
        capture:a.type==='capture',formed,
        searchScore:Number(res.score.toFixed(2)),searchDepth:res.depth
      });
    }
    lineActions.push(at);

    s=ns;n++;
    if(s.turn!==prevTurn){turnChanges++;prevTurn=s.turn;}

    if(!s.winner&&s.phase==='move'){
      const k=repetitionKey(s),times=(seen.get(k)||0)+1;
      seen.set(k,times);
      if(times>=3)drawReason='threefold';
      else if(noProgress>=100)drawReason='no-progress';
    }
  }

  if(!s.winner&&!drawReason)drawReason='safety-stop';
  return{
    winner:s.winner,drawReason,actions:n,turnChanges,totalNodes,
    openingDecisions,samples,trace,finalState:s,budgetCuts
  };
}

function updateOpeningMap(map,decisions,resultBlack){
  for(const d of decisions){
    let rec=map.get(d.key);
    if(!rec){
      rec={phase:d.phase,actor:d.actor,sequence:d.sequence||[],visits:0,actions:new Map()};
      map.set(d.key,rec);
    }
    rec.visits++;
    if((!rec.sequence||!rec.sequence.length)&&d.sequence)rec.sequence=d.sequence;
    let a=rec.actions.get(d.action);
    if(!a){a={visits:0,wins:0,draws:0,losses:0,evalSum:0,depthSum:0};rec.actions.set(d.action,a);}
    a.visits++;
    a.evalSum+=Number(d.searchScore)||0;
    a.depthSum+=Number(d.searchDepth)||0;
    const actorResult=d.actor===1?resultBlack:-resultBlack;
    if(actorResult>0)a.wins++;
    else if(actorResult<0)a.losses++;
    else a.draws++;
  }
}
function loadPriorOpeningBook(map){
  const path='data/openings.json';
  if(!fs.existsSync(path))return 0;
  try{
    const obj=JSON.parse(fs.readFileSync(path,'utf8'));
    const rows=Array.isArray(obj)?obj:(obj.positions||[]);
    let n=0;
    for(const row of rows){
      if(!row?.key)continue;
      let rec=map.get(row.key);
      if(!rec){
        rec={phase:row.phase||'place',actor:row.actor||1,sequence:row.sequence||[],visits:0,actions:new Map()};
        map.set(row.key,rec);
      }
      rec.visits+=Number(row.visits)||0;
      if((!rec.sequence||!rec.sequence.length)&&row.sequence)rec.sequence=row.sequence;
      for(const x of row.actions||[]){
        let a=rec.actions.get(x.action);
        if(!a){a={visits:0,wins:0,draws:0,losses:0,evalSum:0,depthSum:0};rec.actions.set(x.action,a);}
        const v=Number(x.visits)||0;
        a.visits+=v;a.wins+=Number(x.wins)||0;a.draws+=Number(x.draws)||0;a.losses+=Number(x.losses)||0;
        a.evalSum+=(Number(x.avgSearchScore)||0)*v;
        a.depthSum+=(Number(x.avgSearchDepth)||0)*v;
      }
      n++;
    }
    console.log(`[experience] 已载入历史开局局面 ${n} 个`);
    return n;
  }catch(err){
    console.warn('[experience] 历史开局库读取失败，本轮从当前基线重新积累：'+err.message);
    return 0;
  }
}
function serializeOpeningBook(map){
  const rows=[];
  for(const [key,rec] of map){
    const actions=[...rec.actions.entries()].map(([action,a])=>{
      const score=(a.wins+0.5*a.draws)/Math.max(1,a.visits);
      return{
        action,...a,score:Number(score.toFixed(4)),
        avgSearchScore:Number((a.evalSum/Math.max(1,a.visits)).toFixed(2)),
        avgSearchDepth:Number((a.depthSum/Math.max(1,a.visits)).toFixed(2))
      };
    }).sort((a,b)=>b.score-a.score||b.visits-a.visits);
    rows.push({
      key,phase:rec.phase,actor:rec.actor,sequence:rec.sequence||[],
      visits:rec.visits,best:actions[0]?.action||null,actions
    });
  }
  rows.sort((a,b)=>b.visits-a.visits);
  return rows.slice(0,2500);
}

function updateLineMap(map,trace,resultBlack){
  if(!trace.length)return;
  const prefixN=Math.min(8,trace.length);
  const prefix=trace.slice(0,prefixN).map(x=>`${x.actor}:${x.action}`);
  const key=prefix.join('|');
  let r=map.get(key);
  if(!r){
    r={
      prefix,visits:0,blackWins:0,whiteWins:0,draws:0,
      captureEvents:0,patternEvents:0,sample:[]
    };
    map.set(key,r);
  }
  r.visits++;
  if(resultBlack>0)r.blackWins++;
  else if(resultBlack<0)r.whiteWins++;
  else r.draws++;
  const early=trace.slice(0,28);
  r.captureEvents+=early.filter(x=>x.capture).length;
  r.patternEvents+=early.reduce((z,x)=>z+x.formed.length,0);

  // 优先保存一条有胜负、且较长的示范继续线。
  const candidate=trace.slice(0,30);
  if(!r.sample.length || (resultBlack!==0 && r.sampleResult===0)){
    r.sample=candidate;
    r.sampleResult=resultBlack;
  }
}
function serializeTeachingLines(map){
  let rows=[];
  for(const r of map.values()){
    const blackScore=(r.blackWins+0.5*r.draws)/Math.max(1,r.visits);
    const whiteScore=1-blackScore;
    const drawRate=r.draws/Math.max(1,r.visits);
    const attackIndex=(1.5*r.captureEvents+r.patternEvents)/Math.max(1,r.visits);
    const confidence=r.visits/(r.visits+4);
    const edge=Math.abs(blackScore-0.5)*confidence;
    const advantage=blackScore>=0.60?'黑方优势':blackScore<=0.40?'白方优势':'均衡/待验证';
    const style=attackIndex>=2.2?'进攻型':(drawRate>=0.45||attackIndex<0.75)?'稳健/防守型':'攻守均衡';
    rows.push({
      prefix:r.prefix,visits:r.visits,blackWins:r.blackWins,whiteWins:r.whiteWins,draws:r.draws,
      blackScore:Number(blackScore.toFixed(4)),whiteScore:Number(whiteScore.toFixed(4)),
      drawRate:Number(drawRate.toFixed(4)),confidence:Number(confidence.toFixed(4)),
      advantage,style,attackIndex:Number(attackIndex.toFixed(2)),
      sample:r.sample||[],rankScore:Number((edge*Math.log2(r.visits+1)).toFixed(5))
    });
  }
  const reliable=rows.filter(x=>x.visits>=2);
  if(reliable.length)rows=reliable;
  rows.sort((a,b)=>b.rankScore-a.rankScore||b.visits-a.visits);
  return rows.slice(0,40);
}
function buildResponsePoints(openingBook){
  return openingBook.filter(r=>r.visits>=3&&r.actions.length>=2).map(r=>{
    const best=r.actions[0],second=r.actions[1];
    return{
      sequence:r.sequence||[],actor:r.actor,phase:r.phase,visits:r.visits,
      best:best.action,bestScore:best.score,second:second.action,secondScore:second.score,
      gap:Number((best.score-second.score).toFixed(4)),
      avgSearchScore:best.avgSearchScore
    };
  }).filter(x=>x.gap>=0.12)
    .sort((a,b)=>(b.gap*Math.log2(b.visits+1))-(a.gap*Math.log2(a.visits+1)))
    .slice(0,30);
}
function teachingMarkdown(lines,responses){
  const out=[
    '# 五道方优势开局与教学棋谱',
    '',
    '> 说明：胜率来自本轮/历史自我对弈样本，不是数学必胜证明；样本越多越可信。风格标签是按前期成型与掐子事件做的启发式分类。',
    ''
  ];
  const sections=[
    ['黑方优势谱',lines.filter(x=>x.advantage==='黑方优势').slice(0,10)],
    ['白方优势谱',lines.filter(x=>x.advantage==='白方优势').slice(0,10)],
    ['进攻型谱',lines.filter(x=>x.style==='进攻型').slice(0,10)],
    ['稳健/防守型谱',lines.filter(x=>x.style==='稳健/防守型').slice(0,10)]
  ];
  for(const [title,arr] of sections){
    out.push('## '+title,'');
    if(!arr.length){out.push('- 本轮还没有足够样本。','');continue;}
    arr.forEach((x,i)=>{
      const prefix=x.prefix.map(z=>{const [p,...rest]=z.split(':');return (p==='1'?'黑':'白')+' '+actionZh(rest.join(':'));}).join('；');
      const sample=x.sample.map(z=>(z.actor===1?'黑':'白')+' '+actionZh(z.action)+(z.formed?.length?'（成'+z.formed.join('+')+'）':'')+(z.capture?'（掐）':'')).join('；');
      out.push(`### ${i+1}. ${x.advantage} · ${x.style}`);
      out.push('');
      out.push(`- 样本：${x.visits} 盘；黑得分率 ${(x.blackScore*100).toFixed(1)}%；白得分率 ${(x.whiteScore*100).toFixed(1)}%；和棋率 ${(x.drawRate*100).toFixed(1)}%`);
      out.push(`- 前8动作：${prefix}`);
      if(sample)out.push(`- 一条示范继续线：${sample}`);
      out.push('');
    });
  }
  out.push('## 关键应对点','');
  if(!responses.length)out.push('- 本轮还没有达到样本与分差门槛的关键应对点。');
  for(const [i,x] of responses.entries()){
    const seq=x.sequence.length?x.sequence.map(actionZh).join(' → '):'初始局面';
    out.push(`### ${i+1}. ${x.actor===1?'黑方':'白方'}决策`);
    out.push('');
    out.push(`- 到达路线：${seq}`);
    out.push(`- 推荐：${actionZh(x.best)}（样本得分 ${(x.bestScore*100).toFixed(1)}%）`);
    out.push(`- 次选：${actionZh(x.second)}（样本得分 ${(x.secondScore*100).toFixed(1)}%）`);
    out.push(`- 差距：${(x.gap*100).toFixed(1)} 个百分点；该局面样本 ${x.visits} 次`);
    out.push('');
  }
  return out.join('\n');
}


const FEATURE_NAMES=['material','mobility','protected','pattern','potential','center','threat','fork','constraint'];
const FEATURE_SCALE={material:10,mobility:20,protected:15,pattern:10,potential:100,center:50,threat:8,fork:5,constraint:12};
const SCORE_SCALE=500;

function sigmoid(z){
  if(z>30)return 1;
  if(z<-30)return 0;
  return 1/(1+Math.exp(-z));
}
function weightsToTheta(w){
  return FEATURE_NAMES.map(k=>w[k]*FEATURE_SCALE[k]/SCORE_SCALE);
}
function thetaToWeights(theta){
  const w={};
  FEATURE_NAMES.forEach((k,i)=>w[k]=theta[i]*SCORE_SCALE/FEATURE_SCALE[k]);
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  w.material=clamp(w.material,80,400);
  w.mobility=clamp(w.mobility,1,30);
  w.protected=clamp(w.protected,0,60);
  w.pattern=clamp(w.pattern,5,80);
  w.potential=clamp(w.potential,0.2,5);
  w.center=clamp(w.center,0,8);
  w.threat=clamp(w.threat,0,40);
  w.fork=clamp(w.fork,0,60);
  w.constraint=clamp(w.constraint,0,24);
  for(const k of FEATURE_NAMES)w[k]=Number(w[k].toFixed(4));
  return w;
}
function vectorize(f){return FEATURE_NAMES.map(k=>f[k]/FEATURE_SCALE[k]);}
function fitWeights(dataset,base,opts={}){
  if(dataset.length<20)return{
    weights:{...base},trainLoss:null,valLoss:null,samples:dataset.length,
    classCounts:{black:0,draw:0,white:0}
  };

  const data=dataset.map(d=>{
    const y=d.y>0?1:d.y<0?0:0.5;
    const cls=y===1?'black':y===0?'white':'draw';
    return{x:vectorize(d.f),y,cls,sw:1};
  });
  const classCounts={black:0,draw:0,white:0};
  for(const d of data)classCounts[d.cls]++;
  const active=Object.values(classCounts).filter(x=>x>0).length||1;
  for(const d of data){
    const cnt=classCounts[d.cls]||1;
    d.sw=Math.min(3.5,data.length/(active*cnt));
  }

  const buckets={black:[],draw:[],white:[]};
  for(const d of data)buckets[d.cls].push(d);
  const mixed=[];
  const maxLen=Math.max(...Object.values(buckets).map(x=>x.length));
  for(let i=0;i<maxLen;i++)for(const k of ['black','white','draw'])if(buckets[k][i])mixed.push(buckets[k][i]);

  const split=Math.max(1,Math.floor(mixed.length*0.8));
  const train=mixed.slice(0,split),val=mixed.slice(split);
  let theta=weightsToTheta(base);
  const lr=Number(opts.lr??0.014);
  const l2=Number(opts.l2??0.0035);
  const epochs=Math.max(1,Math.floor(opts.epochs??12));

  for(let ep=0;ep<epochs;ep++){
    for(const d of train){
      let z=0;for(let i=0;i<theta.length;i++)z+=theta[i]*d.x[i];
      const p=sigmoid(z),err=p-d.y;
      for(let i=0;i<theta.length;i++){
        theta[i]-=lr*(d.sw*err*d.x[i]+l2*theta[i]);
      }
    }
  }

  function loss(arr){
    if(!arr.length)return null;
    let s=0,ws=0;
    for(const d of arr){
      let z=0;for(let i=0;i<theta.length;i++)z+=theta[i]*d.x[i];
      const p=Math.max(1e-9,Math.min(1-1e-9,sigmoid(z)));
      s+=d.sw*-(d.y*Math.log(p)+(1-d.y)*Math.log(1-p));
      ws+=d.sw;
    }
    return Number((s/Math.max(1e-9,ws)).toFixed(5));
  }
  return{
    weights:thetaToWeights(theta),
    trainLoss:loss(train),
    valLoss:loss(val),
    samples:dataset.length,
    classCounts
  };
}

function clampGenerationStep(base,target){
  const limits={
    material:{rel:0.22,abs:22},
    mobility:{rel:0.15,abs:4},
    protected:{rel:0,abs:8},
    pattern:{rel:0.22,abs:4.5},
    potential:{rel:0.12,abs:0.6},
    center:{rel:0.20,abs:1.6},
    threat:{rel:0,abs:12},
    fork:{rel:0,abs:18},
    constraint:{rel:0,abs:8}
  };
  const out={};
  for(const k of FEATURE_NAMES){
    const b=Number(base[k]),t=Number(target[k]);
    const lim=Math.max(limits[k].abs,Math.abs(b)*limits[k].rel);
    out[k]=Number((b+Math.max(-lim,Math.min(lim,t-b))).toFixed(4));
  }
  return thetaToWeights(weightsToTheta(out));
}
function blendWeights(base,target,alpha){
  const out={};
  for(const k of FEATURE_NAMES)out[k]=Number((base[k]+(target[k]-base[k])*alpha).toFixed(4));
  return thetaToWeights(weightsToTheta(out));
}
function clampAllWeights(w){
  return thetaToWeights(weightsToTheta(w));
}
function addStrategicDelta(base,anchor,delta){
  const target={};
  for(const k of FEATURE_NAMES)target[k]=Number(anchor[k])+(Number(delta[k])||0);
  // 先受全局合法范围约束，再受“单代最大变化”约束，避免人为风格把参数推得过猛。
  return clampGenerationStep(base,clampAllWeights(target));
}
function clampLocalStep(base,target){
  // V5.5：正式基线附近“小步试探”。即使战略方向不同，也不允许一代跳得太远。
  const limits={
    material:{rel:0.08,abs:6.5},
    mobility:{rel:0.08,abs:2.4},
    protected:{rel:0.45,abs:2.4},
    pattern:{rel:0.10,abs:1.9},
    potential:{rel:0.08,abs:0.4},
    center:{rel:0.10,abs:0.8},
    // V6.2：允许覆盖 V6.1 与 V6 之间的中间区间，但仍远小于 V6 的一次性大灌入。
    threat:{rel:0.45,abs:6.0},
    fork:{rel:0.45,abs:6.0},
    constraint:{rel:0.45,abs:2.6}
  };
  const out={};
  for(const k of FEATURE_NAMES){
    const b=Number(base[k]),t=Number(target[k]);
    const lim=Math.max(limits[k].abs,Math.abs(b)*limits[k].rel);
    out[k]=Number((b+Math.max(-lim,Math.min(lim,t-b))).toFixed(4));
  }
  return thetaToWeights(weightsToTheta(out));
}
function localCandidate(base,anchor,name,profile,delta,alpha,fit){
  const blended=blendWeights(base,anchor,alpha);
  const target={};
  for(const k of FEATURE_NAMES)target[k]=Number(blended[k])+(Number(delta[k])||0);
  return{
    name,profile,alpha,fit,delta,
    anchor:blended,
    capped:clampLocalStep(base,target),
    weights:clampLocalStep(base,target)
  };
}
function fusionCandidate(base,learned,name,profile,oldDelta,featureReference,fusionBand,fit){
  // 旧六参数只做很轻的数据微调；V6 三个新棋理权重按 35/45/55/65% 明确分档。
  // 这样每个档位的含义稳定，不会因为拟合噪声把“中间档”再次推成极端档。
  const dataAlpha=0.24;
  const anchor=blendWeights(base,learned,dataAlpha);
  const target={...anchor};
  for(const k of OLD_WEIGHT_KEYS){
    target[k]=Number(anchor[k])+(Number(oldDelta[k])||0)*fusionBand;
  }
  for(const k of NEW_WEIGHT_KEYS){
    const learnedNudge=(Number(learned[k])-Number(base[k]))*0.08;
    target[k]=Number(base[k])+learnedNudge+(Number(featureReference[k])||0)*fusionBand;
  }
  const weights=clampLocalStep(base,clampAllWeights(target));
  return{
    name,profile,alpha:dataAlpha,fit,delta:{oldDelta,featureReference},fusionBand,
    anchor,capped:weights,weights
  };
}
function buildCandidateSet(dataset,base){
  const fit=fitWeights(dataset,base,{lr:0.012,l2:0.0045,epochs:10});
  const learned=clampLocalStep(base,fit.weights);

  // V6.2 的核心：同一批棋理方向按 35/45/55/65% 四档融合。
  // 参考增量覆盖 V6.1 与 V6 之间；最高档仍比 V6 的一次性激进灌入温和。
  const bands=[0.35,0.45,0.55,0.65];
  const profiles=[
    ['战术均衡','tactical-balance',
      {material:-0.30,mobility:0.10,protected:0.30,pattern:0.20,potential:0.04,center:0.00},
      {threat:8.0,fork:6.8,constraint:2.0}],
    ['威胁成型','threat-shape',
      {material:-0.20,mobility:0.05,protected:0.15,pattern:0.40,potential:0.08,center:0.00},
      {threat:8.5,fork:4.8,constraint:1.5}],
    ['双威胁平衡','fork-balance',
      {material:-0.15,mobility:0.15,protected:0.15,pattern:0.25,potential:0.05,center:0.00},
      {threat:5.8,fork:8.0,constraint:1.5}],
    ['稳健防困','safe-tactical',
      {material:0.40,mobility:0.30,protected:0.40,pattern:-0.10,potential:0.00,center:0.00},
      {threat:5.0,fork:4.2,constraint:3.0}]
  ];

  const out=[],seen=new Set();
  for(const [label,profile,oldDelta,featureReference] of profiles){
    for(const band of bands){
      const pct=Math.round(band*100);
      const c=fusionCandidate(base,learned,`${label}${pct}%`,`${profile}-${pct}`,oldDelta,featureReference,band,fit);
      const key=JSON.stringify(c.weights);
      if(seen.has(key))continue;
      seen.add(key);out.push(c);
    }
  }

  // 两个旧参数对照组，用来判断“新棋理融合”是否真的优于只调旧参数。
  for(const [name,alpha] of [['旧参数对照A',0.28],['旧参数对照B',0.45]]){
    const c=localCandidate(base,learned,name,'legacy-control',{},alpha,fit);
    c.fusionBand=0;
    const key=JSON.stringify(c.weights);
    if(!seen.has(key)){seen.add(key);out.push(c);}
  }
  return out;
}
function generateOpeningScenario(seed,depth,base,plies){
  const rng=mulberry32(seed>>>0),localVisits=new Map();
  let s=newState();
  const line=[];
  for(let n=0;n<plies&&!s.winner;n++){
    const res=searchRoot(s,Math.min(2,depth),s.turn,base,'scenario');
    if(!res.action)break;
    const a=pickFromSearch(res,rng,true,s,localVisits,n>=6&&rng()<0.35);
    const vk=stateKey(s)+'|'+actionText(a);
    localVisits.set(vk,(localVisits.get(vk)||0)+1);
    line.push(actionText(a));
    s=apply(s,a);
  }
  return{state:s,line};
}
function buildTournamentScenarios(base,depth,games,seed){
  const targetGames=Math.max(2,games-(games%2));
  const pairs=targetGames/2;
  const scenarios=[];
  for(let p=0;p<pairs;p++){
    const plies=8+(p%6)*2; // 8/10/12/14/16/18 个前期动作，覆盖不同开局阶段。
    const sc=generateOpeningScenario((seed+0x51ED270B+p*2246822519)>>>0,depth,base,plies);
    scenarios.push({p,plies,state:sc.state,line:sc.line});
  }
  return scenarios;
}
function candidateDecisionAt(s,candidate,depth,tag){
  const res=searchRoot(s,depth,s.turn,candidate.weights,tag);
  return{action:actionText(res.action),score:Number(res.score||0),depth:res.depth};
}
function buildDisagreementScenarios(candidates,base,screenDepth,games,seed){
  const targetGames=Math.max(2,games-(games%2));
  const targetScenarios=targetGames/2;
  const probeDepth=Math.min(2,screenDepth);
  const pool=[];
  const seen=new Set();
  const attempts=cfg.games<10?Math.max(12,targetScenarios*4):Math.max(48,targetScenarios*10);

  for(let a=0;a<attempts;a++){
    const plies=8+(a%12)*3; // 8~41 个动作，覆盖摆子、过渡与早期走子阶段。
    const sc=generateOpeningScenario((seed+0x7F4A7C15+a*2246822519)>>>0,screenDepth,base,plies);
    const sk=stateKey(sc.state);
    if(seen.has(sk)||sc.state.winner)continue;
    seen.add(sk);

    const decisions=candidates.map((cand,i)=>({
      name:cand.name,
      ...candidateDecisionAt(sc.state,cand,probeDepth,'probe-'+i)
    }));
    const baseline=actionText(searchRoot(sc.state,probeDepth,sc.state.turn,base,'probe-base').action);
    const unique=[...new Set(decisions.map(x=>x.action).filter(Boolean))];
    const differsFromBase=decisions.filter(x=>x.action&&x.action!==baseline).length;
    const disagreement=unique.length;
    if(disagreement<2)continue;

    pool.push({
      p:pool.length,plies,state:sc.state,line:sc.line,
      disagreement,baselineAction:baseline,decisions,differsFromBase,
      rank:disagreement*10+differsFromBase
    });
  }

  pool.sort((a,b)=>b.rank-a.rank||b.disagreement-a.disagreement);
  let selected=pool.slice(0,targetScenarios);
  const disagreementCount=selected.length;

  // 如果真正分歧局面不够，再用普通合法开局补齐，保证筛选盘数稳定。
  if(selected.length<targetScenarios){
    const fallback=buildTournamentScenarios(base,screenDepth,(targetScenarios-selected.length)*2,(seed+0x243F6A88)>>>0);
    for(const sc of fallback){
      if(selected.length>=targetScenarios)break;
      const sk=stateKey(sc.state);
      if(selected.some(x=>stateKey(x.state)===sk))continue;
      selected.push({...sc,disagreement:1,baselineAction:null,decisions:[],differsFromBase:0,rank:0});
    }
  }
  selected=selected.slice(0,targetScenarios).map((x,i)=>({...x,p:i}));
  return{scenarios:selected,probeDepth,disagreementCount,totalCandidates:candidates.length};
}


function searchRootTeacher(s,targetDepth,ai,w,wtag='teacher'){
  const first=orderedActions(s,ai,w,1);
  if(!first.length)return{action:null,ranked:[],nodes:0,score:evalFor(s,ai,w),depth:0,budgetCut:false};
  // 老师搜索不改变正式对局预算，只在少量关键局面上给更长时间/更多节点。
  const maxMs=targetDepth>=4?1800:targetDepth===3?420:160;
  const deadline=Date.now()+maxMs;
  const maxNodes=targetDepth>=4?320000:targetDepth===3?80000:26000;
  const maxTT=targetDepth>=4?60000:targetDepth===3?16000:7000;
  let completed=null,totalNodes=0,budgetCut=false;
  for(let depth=1;depth<=targetDepth;depth++){
    const aa=orderedActions(s,ai,w,depth);
    const ctx={nodes:0,tt:new Map(),wtag,deadline,maxNodes,maxTT,aborted:false};
    const ranked=[];
    for(const a of aa){
      const ns=apply(s,a);
      const nd=depth-((ns.winner||ns.turn!==s.turn)?1:0);
      const v=alphabeta(ns,nd,-Infinity,Infinity,ai,w,ctx);
      ranked.push({a,v});
      if(ctx.aborted||Date.now()>=deadline)break;
    }
    totalNodes+=ctx.nodes;
    if(!ctx.aborted&&ranked.length===aa.length){
      ranked.sort((x,y)=>y.v-x.v);
      completed={action:ranked[0].a,ranked,score:ranked[0].v,depth};
    }else{budgetCut=true;break;}
    if(Date.now()>=deadline)break;
  }
  if(completed)return{...completed,nodes:totalNodes,budgetCut};
  const fallback=first.map(a=>({a,v:quickOrderScore(s,a,ai,w)})).sort((x,y)=>y.v-x.v);
  return{action:fallback[0].a,ranked:fallback,nodes:totalNodes,score:fallback[0].v,depth:0,budgetCut:true};
}
function teacherLossForAction(teacherRes,actionTxt){
  if(!teacherRes?.ranked?.length||!actionTxt)return 260;
  const best=Number(teacherRes.ranked[0].v)||0;
  const hit=teacherRes.ranked.find(x=>actionText(x.a)===actionTxt);
  if(!hit)return 260;
  return Math.max(0,best-(Number(hit.v)||0));
}
function teacherExamCandidates(candidates,base,scenarios,screenDepth,trainingDepth){
  const teacherDepth=trainingDepth>=4?4:Math.min(4,trainingDepth+1);
  const rows=[];
  let teacherNodes=0,teacherCuts=0;
  for(let i=0;i<scenarios.length;i++){
    const sc=scenarios[i],actor=sc.state.turn;
    const tr=searchRootTeacher(sc.state,teacherDepth,actor,base,'teacher-'+i);
    teacherNodes+=tr.nodes;if(tr.budgetCut)teacherCuts++;
    const shallowBase=searchRoot(sc.state,screenDepth,actor,base,'teacher-base-'+i);
    rows.push({sc,teacher:tr,baselineAction:actionText(shallowBase.action)});
  }
  function examWeights(weights,tag){
    let exact=0,top3=0,totalLoss=0;
    const samples=[];
    for(let i=0;i<rows.length;i++){
      const row=rows[i],actor=row.sc.state.turn;
      const r=searchRoot(row.sc.state,screenDepth,actor,weights,tag+'-'+i);
      const at=actionText(r.action),teacherBest=actionText(row.teacher.action);
      const teacherTop3=topActionTexts(row.teacher,3);
      const loss=teacherLossForAction(row.teacher,at);
      if(at&&at===teacherBest)exact++;
      if(at&&teacherTop3.includes(at))top3++;
      totalLoss+=Math.min(260,loss);
      if(samples.length<10)samples.push({plies:row.sc.plies,teacherBest,chosen:at,loss:Number(loss.toFixed(2))});
    }
    const n=Math.max(1,rows.length),avgLoss=totalLoss/n;
    const exactRate=exact/n,top3Rate=top3/n;
    const lossScore=Math.max(0,1-Math.min(1,avgLoss/180));
    const teacherScore=0.55*exactRate+0.20*top3Rate+0.25*lossScore;
    return{
      games:rows.length,exactBest:exact,top3,exactRate:Number(exactRate.toFixed(4)),top3Rate:Number(top3Rate.toFixed(4)),
      avgTeacherLoss:Number(avgLoss.toFixed(2)),teacherScore:Number(teacherScore.toFixed(4)),samples
    };
  }
  const baseline=examWeights(base,'teacher-exam-base');
  const results=candidates.map((c,i)=>({...c,teacherExam:examWeights(c.weights,'teacher-exam-c'+i)}));
  return{teacherDepth,screenDepth,scenarios:rows.length,teacherNodes,teacherCuts,baseline,results};
}

function tournamentOnScenarios(candidate,base,depth,scenarios,seed){
  const targetGames=scenarios.length*2;
  let candWins=0,baseWins=0,draws=0,totalNodes=0;
  const scenarioSamples=[];

  for(const sc of scenarios){
    if(scenarioSamples.length<12)scenarioSamples.push({plies:sc.plies,line:sc.line});
    for(const candBlack of [true,false]){
      const r=playGame({
        seed:(seed+0x9E3779B9+sc.p*2654435761+(candBlack?17:31))>>>0,
        depth,
        blackWeights:candBlack?candidate:base,
        whiteWeights:candBlack?base:candidate,
        explore:false,collect:false,startState:sc.state
      });
      totalNodes+=r.totalNodes;
      if(r.drawReason)draws++;
      else{
        const candWon=(candBlack&&r.winner===1)||(!candBlack&&r.winner===2);
        if(candWon)candWins++;else baseWins++;
      }
    }
  }
  const score=(candWins+0.5*draws)/Math.max(1,targetGames);
  return{
    games:targetGames,openingScenarios:scenarios.length,candidateWins:candWins,baselineWins:baseWins,draws,
    candidateScore:Number(score.toFixed(4)),
    accepted:score>=0.53,
    totalNodes,scenarioSamples
  };
}
function tournament(candidate,base,depth,games,seed){
  const scenarios=buildTournamentScenarios(base,depth,games,seed);
  return tournamentOnScenarios(candidate,base,depth,scenarios,seed);
}

function rootActionGap(res,otherActionText){
  if(!res?.ranked?.length||!otherActionText)return 0;
  const best=Number(res.ranked[0].v)||0;
  const other=res.ranked.find(x=>actionText(x.a)===otherActionText);
  // 如果对方选择不在当前分支上限里，说明本方搜索至少明显不偏好它，给一个保守固定差值。
  if(!other)return 120;
  return Math.max(0,Math.abs(best-Number(other.v||0)));
}
function topActionTexts(res,k=3){
  return (res?.ranked||[]).slice(0,k).map(x=>actionText(x.a)).filter(Boolean);
}
function rootBestMargin(res){
  if(!res?.ranked?.length)return 0;
  if(res.ranked.length<2)return 160;
  return Math.max(0,Number(res.ranked[0].v||0)-Number(res.ranked[1].v||0));
}
function rankDistance(a,b,k=3){
  const aa=topActionTexts(a,k),bb=topActionTexts(b,k);
  const all=[...new Set([...aa,...bb])];
  let d=0;
  for(const x of all){
    const ia=aa.indexOf(x),ib=bb.indexOf(x);
    const ra=ia<0?k:ia,rb=ib<0?k:ib;
    d+=Math.abs(ra-rb);
  }
  return d;
}
function decisionContrast(baseRes,candRes){
  const baselineAction=actionText(baseRes?.action),candidateAction=actionText(candRes?.action);
  const hard=!!baselineAction&&!!candidateAction&&baselineAction!==candidateAction;
  const top3Base=topActionTexts(baseRes,3),top3Candidate=topActionTexts(candRes,3);
  const rankDiff=rankDistance(baseRes,candRes,3);
  const baselineMargin=rootBestMargin(baseRes),candidateMargin=rootBestMargin(candRes);
  const confidenceGap=Math.abs(baselineMargin-candidateMargin);
  const evalGap=Math.abs(Number(baseRes?.score||0)-Number(candRes?.score||0));
  const candidateGap=hard?rootActionGap(candRes,baselineAction):0;
  const baselineGap=hard?rootActionGap(baseRes,candidateAction):0;

  // 软分歧：最佳着相同，但后续排序/确信程度已经明显不同。
  const soft=!hard && (
    rankDiff>=2 ||
    (top3Base[1]&&top3Candidate[1]&&top3Base[1]!==top3Candidate[1]&&Math.max(baselineMargin,candidateMargin)>=18) ||
    confidenceGap>=28
  );
  // 单独保留“评价分差”通道：即便前三名顺序接近，只要双方对局面好坏判断相差明显，也值得拿来检验。
  const evalOnly=!hard&&!soft&&evalGap>=60;
  let type=hard?'hard':soft?'soft':evalOnly?'eval-gap':'weak';
  let rank=0;
  if(hard)rank=1000+Math.min(220,candidateGap)+Math.min(220,baselineGap)+Math.min(120,evalGap*0.35);
  else if(soft)rank=520+rankDiff*55+Math.min(170,confidenceGap)+Math.min(150,evalGap*0.45);
  else if(evalOnly)rank=300+Math.min(260,evalGap);
  else rank=rankDiff*20+Math.min(120,confidenceGap*0.5)+Math.min(120,evalGap*0.25);
  return{
    type,hard,soft,evalOnly,rank:Number(rank.toFixed(2)),
    baselineAction,candidateAction,top3Base,top3Candidate,
    rankDiff,
    baselineMargin:Number(baselineMargin.toFixed(2)),candidateMargin:Number(candidateMargin.toFixed(2)),
    confidenceGap:Number(confidenceGap.toFixed(2)),evalGap:Number(evalGap.toFixed(2)),
    baselineGap:Number(baselineGap.toFixed(2)),candidateGap:Number(candidateGap.toFixed(2))
  };
}
function parseActionText(t){
  if(!t||t==='PASS')return{type:'pass'};
  const cell=x=>{
    if(!/^[A-E][1-5]$/.test(x))return null;
    return idx(x.charCodeAt(0)-65,Number(x[1])-1);
  };
  if(t[0]==='P')return{type:'place',to:cell(t.slice(1))};
  if(t[0]==='X')return{type:'capture',to:cell(t.slice(1))};
  if(t[0]==='M'){
    const [a,b]=t.slice(1).split('-');
    return{type:'move',from:cell(a),to:cell(b)};
  }
  return null;
}
function replaySequence(sequence){
  let s=newState();
  for(const t of sequence||[]){
    if(s.winner)return null;
    const a=parseActionText(t);
    if(!a)return null;
    const legal=actions(s).some(x=>actionText(x)===actionText(a));
    if(!legal)return null;
    s=apply(s,a);
  }
  return s;
}
function historicalScenarioPool(openingMap,limit=140){
  const rows=[...openingMap.entries()]
    .map(([key,rec])=>({key,rec}))
    .filter(x=>Array.isArray(x.rec.sequence)&&x.rec.sequence.length>=6&&x.rec.sequence.length<=48)
    .sort((a,b)=>(b.rec.visits||0)-(a.rec.visits||0))
    .slice(0,limit*2);
  const out=[];
  for(const row of rows){
    if(out.length>=limit)break;
    const state=replaySequence(row.rec.sequence);
    if(!state||state.winner)continue;
    // sequence 重放必须精确还原到同一个状态，否则历史记录不进入正式测试池。
    if(stateKey(state)!==row.key)continue;
    out.push({state,line:[...row.rec.sequence],plies:row.rec.sequence.length,source:'history',visits:row.rec.visits||0});
  }
  return out;
}
function buildBaselineCandidateContrastScenarios(candidate,base,tourDepth,games,seed,openingMap){
  const targetGames=Math.max(2,games-(games%2));
  const targetScenarios=targetGames/2;
  const probeDepth=Math.min(2,tourDepth);
  const pool=[],seen=new Set();
  const generatedAttempts=cfg.games<10?Math.max(8,targetScenarios*4):Math.max(56,targetScenarios*12);

  function inspect(sc,source='generated',visits=0){
    const sk=stateKey(sc.state);
    if(seen.has(sk)||sc.state.winner)return;
    seen.add(sk);
    const actor=sc.state.turn;
    const bRes=searchRoot(sc.state,probeDepth,actor,base,'tour-probe-base');
    const cRes=searchRoot(sc.state,probeDepth,actor,candidate,'tour-probe-candidate');
    const contrast=decisionContrast(bRes,cRes);
    pool.push({
      p:pool.length,plies:sc.plies,state:sc.state,line:sc.line,source,visits,
      ...contrast
    });
  }

  // 先从本轮随机生成的多阶段局面中找差异。
  for(let a=0;a<generatedAttempts;a++){
    const plies=8+(a%12)*3;
    const sc=generateOpeningScenario((seed+0xB7E15162+a*2246822519)>>>0,tourDepth,base,plies);
    inspect({state:sc.state,line:sc.line,plies},'generated',0);
  }

  // 再从累计的 2500 开局经验中抽高访问量局面。这样不仅“造题”，也会检验真正反复出现的实战局面。
  for(const h of historicalScenarioPool(openingMap,cfg.games<10?Math.max(8,targetScenarios*4):Math.max(96,targetScenarios*8))){
    inspect(h,'history',h.visits||0);
  }

  const typeWeight={hard:4,soft:3,'eval-gap':2,weak:1};
  pool.sort((a,b)=>
    (typeWeight[b.type]||0)-(typeWeight[a.type]||0) ||
    b.rank-a.rank ||
    b.visits-a.visits
  );

  // 优先真正硬/软/评价分差；不够时用“差异度最高”的弱分歧补齐，确保正式对比池不会再出现 0 场。
  let selected=pool.filter(x=>x.type!=='weak').slice(0,targetScenarios);
  if(selected.length<targetScenarios){
    const used=new Set(selected.map(x=>stateKey(x.state)));
    for(const x of pool){
      if(selected.length>=targetScenarios)break;
      const sk=stateKey(x.state);
      if(used.has(sk))continue;
      used.add(sk);selected.push(x);
    }
  }
  selected=selected.slice(0,targetScenarios).map((x,i)=>({...x,p:i}));
  const counts={hard:0,soft:0,evalGap:0,weak:0,history:0,generated:0};
  for(const x of selected){
    if(x.type==='hard')counts.hard++;
    else if(x.type==='soft')counts.soft++;
    else if(x.type==='eval-gap')counts.evalGap++;
    else counts.weak++;
    if(x.source==='history')counts.history++;else counts.generated++;
  }
  return{
    scenarios:selected,probeDepth,targetScenarios,attemptedPositions:seen.size,
    counts,qualifiedCount:selected.filter(x=>x.type!=='weak').length,
    poolSize:pool.length
  };
}

function emptyTournamentResult(){
  return{
    games:0,openingScenarios:0,candidateWins:0,baselineWins:0,draws:0,
    candidateScore:0.5,accepted:false,totalNodes:0,scenarioSamples:[]
  };
}

function buildPromotionTournament(candidate,base,depth,games,seed,openingMap){
  const targetGames=Math.max(4,games-(games%2));
  const totalScenarios=targetGames/2;
  // V6.3 终审：50% 关键对比池 + 50% 独立随机池，全部交换黑白。
  const wantedContrastScenarios=Math.max(1,Math.round(totalScenarios*0.50));
  const contrastPack=buildBaselineCandidateContrastScenarios(
    candidate,base,depth,wantedContrastScenarios*2,(seed+0x3C6EF372)>>>0,openingMap
  );
  const contrastScenarios=contrastPack.scenarios;
  const controlScenarioCount=Math.max(1,totalScenarios-contrastScenarios.length);
  const controlScenarios=buildTournamentScenarios(
    base,depth,controlScenarioCount*2,(seed+0xA54FF53A)>>>0
  ).map((x,i)=>({...x,p:i}));

  const contrast=contrastScenarios.length
    ? tournamentOnScenarios(candidate,base,depth,contrastScenarios,(seed+0x510E527F)>>>0)
    : emptyTournamentResult();
  const control=tournamentOnScenarios(candidate,base,depth,controlScenarios,(seed+0x9B05688C)>>>0);

  const candidateWins=contrast.candidateWins+control.candidateWins;
  const baselineWins=contrast.baselineWins+control.baselineWins;
  const draws=contrast.draws+control.draws;
  const actualGames=contrast.games+control.games;
  const score=(candidateWins+0.5*draws)/Math.max(1,actualGames);
  const accepted=score>=0.55 && contrast.candidateScore>=0.50 && control.candidateScore>=0.50;

  return{
    games:actualGames,
    openingScenarios:contrast.openingScenarios+control.openingScenarios,
    candidateWins,baselineWins,draws,
    candidateScore:Number(score.toFixed(4)),accepted,
    totalNodes:contrast.totalNodes+control.totalNodes,
    mode:'v6.3-fixed-candidate-depth4-final-50-50',
    acceptancePolicy:{overallMin:0.55,contrastMin:0.50,controlMin:0.50},
    contrastTargetShare:0.50,
    contrastProbeDepth:contrastPack.probeDepth,
    contrastRequestedScenarios:wantedContrastScenarios,
    contrastFoundScenarios:contrastScenarios.length,
    contrastQualifiedScenarios:contrastPack.qualifiedCount,
    contrastCounts:contrastPack.counts,
    contrastPoolSize:contrastPack.poolSize,
    contrastAttemptedPositions:contrastPack.attemptedPositions,
    contrast,
    control,
    contrastSamples:contrastScenarios.slice(0,16).map(sc=>({
      plies:sc.plies,line:sc.line,source:sc.source,type:sc.type,visits:sc.visits,
      baselineAction:sc.baselineAction,candidateAction:sc.candidateAction,
      top3Base:sc.top3Base,top3Candidate:sc.top3Candidate,rankDiff:sc.rankDiff,
      baselineMargin:sc.baselineMargin,candidateMargin:sc.candidateMargin,
      confidenceGap:sc.confidenceGap,evalGap:sc.evalGap,
      baselineGap:sc.baselineGap,candidateGap:sc.candidateGap,rank:sc.rank
    })),
    scenarioSamples:[...contrast.scenarioSamples,...control.scenarioSamples].slice(0,12)
  };
}


const started=Date.now();
const openingMap=new Map();
const priorOpeningPositions=loadPriorOpeningBook(openingMap);

function approx(a,b,tol=0.0002){return Math.abs(Number(a)-Number(b))<=tol;}
function assertExpectedBaseline(){
  if(BASE_GENERATION!==4){
    throw new Error(`V6.4 冲 Gen5 要求正式基线仍为 Gen4；当前检测到 Gen${BASE_GENERATION}，为避免误测已停止。`);
  }
  const expected={material:80.8132,mobility:30,protected:4.2116,pattern:18.7737,potential:5,center:8};
  for(const [k,v] of Object.entries(expected)){
    if(!approx(BASE_WEIGHTS[k],v,0.001)){
      throw new Error(`V6.4 检测到 Gen4 基线参数 ${k}=${BASE_WEIGHTS[k]} 与预期 ${v} 不一致，已停止。`);
    }
  }
}
assertExpectedBaseline();

if(cfg.games>=10 && cfg.depth!==4){
  throw new Error('V6.4 是深度4冲 Gen5 版：正式运行请把 Depth 选择为 4。');
}
const realRun=cfg.games>=10;
const examDepth=realRun?4:Math.max(2,cfg.depth);
const baseSeed=cfg.seed>>>0;

const HIST_TACTICAL35={
  material:80.513,mobility:30,protected:4.8525,pattern:18.3877,potential:5,center:8,
  threat:3.28,fork:2.86,constraint:0.908
};
const HIST_THREAT35={
  material:80.548,mobility:30,protected:4.8401,pattern:18.5593,potential:5,center:7.8516,
  threat:3.455,fork:2.16,constraint:0.733
};
function interpWeights(target,scale,oldScale=scale,newScale=scale){
  const out={};
  for(const k of OLD_WEIGHT_KEYS)out[k]=Number((BASE_WEIGHTS[k]+(target[k]-BASE_WEIGHTS[k])*oldScale).toFixed(4));
  for(const k of NEW_WEIGHT_KEYS)out[k]=Number((BASE_WEIGHTS[k]+(target[k]-BASE_WEIGHTS[k])*newScale).toFixed(4));
  return out;
}
function mixTargets(a,b,t=0.5){
  const out={};
  for(const k of FEATURE_NAMES)out[k]=Number((Number(a[k])*(1-t)+Number(b[k])*t).toFixed(4));
  return out;
}
function makeCandidate(name,profile,weights,note=''){
  return{name,profile,weights,source:'V6.4-repair-search',note};
}
function buildV64Candidates(){
  const out=[];
  // 围绕历史 D4 表现更稳的“战术均衡35%”做密集局部搜索。
  for(const [label,s] of [['60',0.60],['75',0.75],['90',0.90],['100',1.00],['110',1.10]]){
    out.push(makeCandidate(`战术修复${label}%`,'tactical-repair',interpWeights(HIST_TACTICAL35,s),`历史战术35%的${label}%局部幅度`));
  }
  // 威胁方向保留少量较稳档，V6.3 原候选仍作为参照，但已使用相位抑制语义。
  for(const [label,s] of [['75',0.75],['90',0.90],['100',1.00]]){
    out.push(makeCandidate(`威胁修复${label}%`,'threat-repair',interpWeights(HIST_THREAT35,s),`历史威胁35%的${label}%局部幅度`));
  }
  // 把旧六参数与新三参数拆开，判断问题究竟来自旧权重偏移还是战术新特征过强。
  out.push(makeCandidate('战术旧75新100','decoupled',interpWeights(HIST_TACTICAL35,1,0.75,1.00),'旧六参数收敛一些，新棋理保持历史战术35强度'));
  out.push(makeCandidate('战术旧100新75','decoupled',interpWeights(HIST_TACTICAL35,1,1.00,0.75),'旧六参数保持历史战术35，新棋理再收敛'));
  const mix=mixTargets(HIST_TACTICAL35,HIST_THREAT35,0.5);
  out.push(makeCandidate('战术威胁混合85','hybrid',interpWeights(mix,0.85),'两个历史方向取中间再收敛'));
  out.push(makeCandidate('新棋理保守','new-only',{
    ...BASE_WEIGHTS,threat:2.35,fork:1.85,constraint:0.65
  },'完全保留Gen4旧六参数，只小幅加入新棋理'));
  return out;
}
const candidateSet=buildV64Candidates();

// V6.3 正式终审的16个高优先关键局面，只用于修复/筛选，不参与最终晋级考试。
const V63_REPAIR_LINES=[["PC3","PB4","PD4","PB2","PC5","PE3","PA3","PC4","PC1","PD5","PD2","PC2","PA1","PB3","PA4","PD3","PE1","PB5","PB1","PA2","PE2","PE4","PD1","PE5","PA5","XC3","XB4","MD3-C3","XA3"],["PC3","PB2","PC1","PB4","PC5","PD4","PC2","PC4","PB3","PD2","PD3","PE3","PA4","PB1","PA2","PA3","PD1","PE2","PE5","PD5","PA1","PE4","PA5"],["PB4","PB3","PB2","PC2","PA3","PC5","PC1","PD3","PD1","PC3","PA4","PC4","PE3","PD2","PE1","PE4","PD5","PA2","PA5","PA1","PE5","PD4","PB1","PB5","PE2","XB4","XC4","MD4-C4","MD3-D4","MB3-B4","XA5","MB2-B3"],["PB4","PC3","PA3","PC5","PD2","PD4","PE3","PC1","PC4","PB2"],["PC3","PB3","PD2","PC5","PE3","PC1","PB4","PB2","PA3","PD3","PD4"],["PC3","PB3","PB2","PC1","PD4","PD2","PE3","PC5","PB4"],["PC3","PB3","PB4","PC5","PD2","PD4","PE3","PC1","PB2"],["PC3","PB3","PD2","PC4","PB4","PC2","PE3","PC1"],["PC3","PB3","PD2","PE3","PB4","PC2"],["PC3","PB3","PD2","PC4","PB4","PC2"],["PB2","PC3","PB4","PD2","PA3","PC5","PC1","PD4","PA2","PE3","PB3"],["PC3","PB4","PA3","PC1","PE3","PD3","PD2","PC5","PB2","PB3","PD4","PA1","PC4","PE2","PA5","PE4","PC2"],["PC3","PB2","PA3","PB4","PD2","PD3","PC1","PE3","PC5","PD1","PE4","PC2","PD4","PE5"],["PC3","PB3","PD2","PC4","PC1","PE3","PA3","PB2","PB4","PC5","PD4","PA5","PC2","PD1","PD3","PA2","PE4","PE1","PA1","PE5"],["PC3","PB2","PB4","PD2","PA3","PC5","PD3","PB3","PC1","PC4","PD5","PD4","PE3","PC2"],["PC3","PB4","PB2","PC5","PA3","PC1","PC4","PD2","PE3","PD3","PD5","PB3","PB5","PA2","PC2","PD4","PD1","PE1","PB1","PA1"]];
function repairScenarios(){
  const out=[],seen=new Set();
  for(const line of V63_REPAIR_LINES){
    const state=replaySequence(line);
    if(!state||state.winner)continue;
    const sk=stateKey(state);if(seen.has(sk))continue;seen.add(sk);
    out.push({p:out.length,plies:line.length,state,line,source:'v6.3-failure'});
  }
  return out;
}
function uniqueScenarios(rows,limit=999){
  const out=[],seen=new Set();
  for(const x of rows){
    if(out.length>=limit)break;
    const sk=stateKey(x.state);if(seen.has(sk))continue;seen.add(sk);
    out.push({...x,p:out.length});
  }
  return out;
}
function scoreDualTour(t){
  const floor=Math.min(t.contrast.candidateScore,t.control.candidateScore);
  return{
    floor:Number(floor.toFixed(4)),
    selection:Number((0.58*t.candidateScore+0.42*floor).toFixed(4))
  };
}
function buildSharedDualPool(candidates,base,depth,games,seed,openingMap){
  const targetGames=Math.max(4,games-(games%2));
  const totalScenarios=targetGames/2;
  const wantedContrast=Math.max(1,Math.round(totalScenarios*0.50));
  const pool=[],seen=new Set();
  for(let i=0;i<candidates.length;i++){
    const pack=buildBaselineCandidateContrastScenarios(
      candidates[i].weights,base,depth,wantedContrast*2,(seed+i*0x9E3779B9)>>>0,openingMap
    );
    for(const sc of pack.scenarios){
      const sk=stateKey(sc.state);
      if(seen.has(sk))continue;seen.add(sk);
      pool.push({...sc,discoveredBy:candidates[i].name});
    }
  }
  const typeWeight={hard:4,soft:3,'eval-gap':2,weak:1};
  pool.sort((a,b)=>(typeWeight[b.type]||0)-(typeWeight[a.type]||0)||b.rank-a.rank||(b.visits||0)-(a.visits||0));
  let contrast=pool.slice(0,wantedContrast);
  if(contrast.length<wantedContrast){
    const fill=buildTournamentScenarios(base,depth,(wantedContrast-contrast.length)*2,(seed+0x243F6A88)>>>0);
    contrast=uniqueScenarios([...contrast,...fill],wantedContrast);
  }
  contrast=contrast.slice(0,wantedContrast).map((x,i)=>({...x,p:i}));
  const controlCount=Math.max(1,totalScenarios-contrast.length);
  const control=buildTournamentScenarios(base,depth,controlCount*2,(seed+0xB7E15162)>>>0)
    .slice(0,controlCount).map((x,i)=>({...x,p:i}));
  return{games:(contrast.length+control.length)*2,contrast,control,discoveredContrast:pool.length};
}
function runSharedDualTournament(candidate,base,depth,pool,seed){
  const contrast=tournamentOnScenarios(candidate,base,depth,pool.contrast,(seed+0x510E527F)>>>0);
  const control=tournamentOnScenarios(candidate,base,depth,pool.control,(seed+0x9B05688C)>>>0);
  const candidateWins=contrast.candidateWins+control.candidateWins;
  const baselineWins=contrast.baselineWins+control.baselineWins;
  const draws=contrast.draws+control.draws;
  const games=contrast.games+control.games;
  const candidateScore=(candidateWins+0.5*draws)/Math.max(1,games);
  return{
    games,openingScenarios:contrast.openingScenarios+control.openingScenarios,
    candidateWins,baselineWins,draws,candidateScore:Number(candidateScore.toFixed(4)),
    contrast,control,totalNodes:contrast.totalNodes+control.totalNodes
  };
}

console.log(`[v6.4] 当前基线 Gen${BASE_GENERATION}；候选 ${candidateSet.length} 个；Depth=${examDepth}；Seed=${baseSeed}`);
console.log('[v6.4] 战术相位缩放：place=0.55, opening=0.75, capture=0.90, move=1.00');

// Stage 1：深度4老师考试。真实运行将 V6.3 失败局面与新候选分歧局面合并。
const repair=repairScenarios();
const screenDepth=realRun?3:2;
const freshPack=buildDisagreementScenarios(
  candidateSet,BASE_WEIGHTS,screenDepth,realRun?16:4,(baseSeed+0x13579BDF)>>>0
);
const teacherScenarios=uniqueScenarios([...repair,...freshPack.scenarios],realRun?24:6);
const teacherPack=teacherExamCandidates(candidateSet,BASE_WEIGHTS,teacherScenarios,screenDepth,examDepth);
const teacherRanked=[...teacherPack.results].sort((a,b)=>
  b.teacherExam.teacherScore-a.teacherExam.teacherScore ||
  b.teacherExam.exactRate-a.teacherExam.exactRate ||
  a.teacherExam.avgTeacherLoss-b.teacherExam.avgTeacherLoss
);
const stage1Count=realRun?5:Math.min(3,teacherRanked.length);
const stage1=teacherRanked.slice(0,stage1Count);
console.log(`[v6.4] Stage1 老师考试 ${teacherScenarios.length} 局面；入围：${stage1.map(x=>x.name).join(' / ')}`);

// Stage 2：所有入围候选用完全相同的一套深度4双池小擂台。
const stage2Games=realRun?20:4;
const stage2Pool=buildSharedDualPool(stage1,BASE_WEIGHTS,examDepth,stage2Games,(baseSeed+0xBB67AE85)>>>0,openingMap);
const stage2Rows=stage1.map((c,i)=>{
  const tour=runSharedDualTournament(c.weights,BASE_WEIGHTS,examDepth,stage2Pool,(baseSeed+0x3C6EF372+i*17)>>>0);
  const ss=scoreDualTour(tour);
  return{...c,stage2:tour,stage2Floor:ss.floor,stage2Score:ss.selection};
}).sort((a,b)=>
  b.stage2Floor-a.stage2Floor || b.stage2Score-a.stage2Score ||
  b.stage2.candidateScore-a.stage2.candidateScore ||
  b.teacherExam.teacherScore-a.teacherExam.teacherScore
);
const stage2Count=realRun?2:Math.min(2,stage2Rows.length);
const stage2Finalists=stage2Rows.slice(0,stage2Count);
console.log(`[v6.4] Stage2 ${stage2Games}盘共享双池；入围：${stage2Finalists.map(x=>`${x.name} ${(x.stage2.candidateScore*100).toFixed(1)}%`).join(' / ')}`);

// Stage 3：两个 finalist 再换一套完全独立共享双池，减少小样本偶然性。
const stage3Games=realRun?40:4;
const stage3Pool=buildSharedDualPool(stage2Finalists,BASE_WEIGHTS,examDepth,stage3Games,(baseSeed+0xA54FF53A)>>>0,openingMap);
const stage3Rows=stage2Finalists.map((c,i)=>{
  const tour=runSharedDualTournament(c.weights,BASE_WEIGHTS,examDepth,stage3Pool,(baseSeed+0x1F83D9AB+i*31)>>>0);
  const ss=scoreDualTour(tour);
  return{...c,stage3:tour,stage3Floor:ss.floor,stage3Score:ss.selection};
}).sort((a,b)=>
  b.stage3Floor-a.stage3Floor || b.stage3Score-a.stage3Score ||
  b.stage3.candidateScore-a.stage3.candidateScore ||
  b.stage2Floor-a.stage2Floor || b.teacherExam.teacherScore-a.teacherExam.teacherScore
);
const selected=stage3Rows[0];
console.log(`[v6.4] Stage3 ${stage3Games}盘复核冠军：${selected.name}；总分 ${(selected.stage3.candidateScore*100).toFixed(1)}%；关键 ${(selected.stage3.contrast.candidateScore*100).toFixed(1)}%；随机 ${(selected.stage3.control.candidateScore*100).toFixed(1)}%`);

// Final：只考冠军；全新 Seed，独立于前三个阶段。
const finalExamGames=realRun?(cfg.games>=500?160:120):4;
const finalSeed=(baseSeed+0x6A09E667)>>>0;
const tour=buildPromotionTournament(
  selected.weights,BASE_WEIGHTS,examDepth,finalExamGames,finalSeed,openingMap
);
tour.finalExam=true;
tour.v64Champion=selected.name;
tour.finalExamGames=finalExamGames;
tour.finalExamDepth=examDepth;
tour.acceptancePolicy={overallMin:0.55,contrastMin:0.50,controlMin:0.50,poolShare:'50/50',colorSwap:true};
tour.accepted=Boolean(
  tour.candidateScore>=0.55 && tour.contrast.candidateScore>=0.50 && tour.control.candidateScore>=0.50
);

const elapsed=(Date.now()-started)/1000;
const openingBook=serializeOpeningBook(openingMap);
const responsePoints=buildResponsePoints(openingBook);
const generatedAt=new Date().toISOString();
const engineConfig={
  evaluatorVersion:'v6.4-phase-damped-tactics',
  tacticalPhaseScale:{place:0.55,opening:0.75,capture:0.90,move:1.00}
};
const report={
  version:'deep-train-v6.4-gen5-repair-shared-dual-final',rulesVersion:'V2.3-draw',baselineGeneration:BASE_GENERATION,
  generatedAt,config:{...cfg,mode:'v6.4-gen5-repair-search',screenDepth,examDepth,stage2Games,stage3Games,finalExamGames},
  elapsedSeconds:Number(elapsed.toFixed(3)),baselineWeights:BASE_WEIGHTS,engineConfig,
  priorOpeningPositions,openingBookPositions:openingBook.length,
  repairScenarioCount:repair.length,freshDisagreementScenarios:freshPack.scenarios.length,
  teacherExam:{teacherDepth:teacherPack.teacherDepth,scenarios:teacherPack.scenarios,baseline:teacherPack.baseline},
  candidates:teacherRanked.map(x=>({name:x.name,profile:x.profile,weights:x.weights,note:x.note,teacherExam:x.teacherExam})),
  stage2:stage2Rows.map(x=>({name:x.name,weights:x.weights,floor:x.stage2Floor,selectionScore:x.stage2Score,tournament:x.stage2})),
  stage3:stage3Rows.map(x=>({name:x.name,weights:x.weights,floor:x.stage3Floor,selectionScore:x.stage3Score,tournament:x.stage3})),
  selected:{name:selected.name,profile:selected.profile,weights:selected.weights,note:selected.note},
  tournament:tour
};

fs.mkdirSync('deep-train-results',{recursive:true});
fs.writeFileSync('deep-train-results/deep-report.json',JSON.stringify(report,null,2));
fs.writeFileSync('deep-train-results/openings.json',JSON.stringify({
  version:'opening-book-v5',rulesVersion:'V2.3-draw',generatedAt,baselineWeights:BASE_WEIGHTS,positions:openingBook
},null,2));
fs.writeFileSync('deep-train-results/teaching-openings.json',JSON.stringify({
  version:'teaching-openings-v1',rulesVersion:'V2.3-draw',generatedAt,lines:[],responsePoints
},null,2));
fs.writeFileSync('deep-train-results/teaching-openings.md',
  '# 五道方 V6.4 Gen5 修复搜索\n\n本轮重点是参数修复与深度4晋级，不新增教学主线；累计开局库原样保留。\n'
);
fs.writeFileSync('deep-train-results/eval.json',JSON.stringify({
  version:'eval-v6.4-repair',rulesVersion:'V2.3-draw',generatedAt,baseline:BASE_WEIGHTS,
  candidate:selected.weights,engineConfig,accepted:tour.accepted,tournament:tour
},null,2));
const nextGeneration=tour.accepted?BASE_GENERATION+1:BASE_GENERATION;
fs.writeFileSync('deep-train-results/next-baseline.json',JSON.stringify({
  generation:nextGeneration,name:'Gen'+nextGeneration,rulesVersion:'V2.3-draw',generatedAt,
  sourceTraining:{games:finalExamGames,depth:examDepth,seed:finalSeed,trainerVersion:report.version,mode:'v6.4-gen5-repair-search'},
  accepted:tour.accepted,selectedCandidate:selected.name,
  weights:tour.accepted?selected.weights:BASE_WEIGHTS,
  engineConfig:tour.accepted?engineConfig:{evaluatorVersion:'gen4-legacy',tacticalPhaseScale:{place:1,opening:1,capture:1,move:1}},
  promotionTest:tour
},null,2));
fs.writeFileSync('deep-train-results/candidate-screening.json',JSON.stringify({
  version:'candidate-screening-v6.4-repair-shared-dual',baselineGeneration:BASE_GENERATION,baselineWeights:BASE_WEIGHTS,
  engineConfig,selected:selected.name,repairScenarioCount:repair.length,
  teacherQualified:stage1.map(x=>x.name),stage2Finalists:stage2Finalists.map(x=>x.name),
  candidates:teacherRanked.map(x=>({name:x.name,profile:x.profile,weights:x.weights,note:x.note,teacherExam:x.teacherExam})),
  stage2:stage2Rows.map(x=>({name:x.name,floor:x.stage2Floor,score:x.stage2Score,tournament:x.stage2})),
  stage3:stage3Rows.map(x=>({name:x.name,floor:x.stage3Floor,score:x.stage3Score,tournament:x.stage3}))
},null,2));
fs.writeFileSync('deep-train-results/promotion-tournament.json',JSON.stringify({
  version:'promotion-tournament-v6.4-independent-depth4-final',baselineGeneration:BASE_GENERATION,
  selectedCandidate:selected.name,baselineWeights:BASE_WEIGHTS,candidateWeights:selected.weights,engineConfig,tournament:tour
},null,2));

const summary=[
  '# 五道方 AI V6.4 · Gen5 修复搜索 + 深度4独立终审','',
  `- 当前正式基线：Gen${BASE_GENERATION}`,
  `- V6.3 失败修复局面：${repair.length} 个；新增候选分歧局面：${freshPack.scenarios.length} 个`,
  `- 候选总数：${candidateSet.length}；老师考试后：${stage1.map(x=>x.name).join(' / ')}`,
  `- 战术相位缩放：摆子55% / 满盘先掐75% / 掐子90% / 正常走棋100%`,
  `- Stage2 共享双池：${stage2Games}盘；前二：${stage2Finalists.map(x=>`${x.name} ${(x.stage2.candidateScore*100).toFixed(1)}%`).join(' / ')}`,
  `- Stage3 共享双池：${stage3Games}盘；冠军：${selected.name}`, 
  `- 冠军参数：${JSON.stringify(selected.weights)}`,'',
  '## 独立终审','',
  `- Seed：${finalSeed}`,
  `- 总对局：${tour.games}（全部交换黑白）`,
  `- 关键对比池：候选 ${tour.contrast.candidateWins}胜 / 基线 ${tour.contrast.baselineWins}胜 / ${tour.contrast.draws}和；得分率 ${(tour.contrast.candidateScore*100).toFixed(1)}%`,
  `- 随机池：候选 ${tour.control.candidateWins}胜 / 基线 ${tour.control.baselineWins}胜 / ${tour.control.draws}和；得分率 ${(tour.control.candidateScore*100).toFixed(1)}%`,
  `- 总计：候选 ${tour.candidateWins}胜 / 基线 ${tour.baselineWins}胜 / ${tour.draws}和；总得分率 ${(tour.candidateScore*100).toFixed(1)}%`,
  `- 晋级条件：总分≥55%，且关键池、随机池各≥50%`,
  `- 是否升级：${tour.accepted?'是 → 自动生成 Gen'+(BASE_GENERATION+1):'否 → 保留 Gen'+BASE_GENERATION}`,
  `- 总用时：${elapsed.toFixed(2)} 秒`,'',
  '> V6.4 不降低晋级线，也不重复抽同一个候选的Seed。它先根据V6.3失败证据修参数，再用独立终审决定是否真正升Gen5。'
].join('\n');
fs.writeFileSync('deep-train-results/summary.md',summary);
console.log('\n'+summary);
