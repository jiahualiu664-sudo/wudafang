#!/usr/bin/env node
'use strict';

/*
  五道方 V8 LAB A+B
  ------------------------------------------------------------
  目标：
  A. 重新实现 5x5 Bitboard 规则核心 + 数字 claimed + make/unmake
  B. 建立 Oracle 裁判 + 全合法着 PVS/Alpha-Beta + TT + Killer/History
     + 真正战术延伸 + 战术静态搜索
  C. 增加纯搜索器擂台：V8 新搜索 vs Gen4 兼容旧搜索，同一评价、同一规则、成对换边

  重要：
  - 这是实验引擎，不会覆盖 data/ai-baseline.json。
  - 第一阶段默认只跑 correctness smoke test，不做 Gen5 晋级。
  - Gen4 正式基线完全保留。
*/

import fs from 'node:fs';

const VERSION='v8-lab-c-0.2';
const PHASE={PLACE:0,OPENING:1,MOVE:2,CAPTURE:3,GAMEOVER:4};
const PHASE_NAME=['place','opening','move','capture','gameover'];
const N=5;
const bit=i=>(1<<i)>>>0;
const idx=(r,c)=>r*5+c;
const rc=i=>[Math.floor(i/5),i%5];
const inb=(r,c)=>r>=0&&r<5&&c>=0&&c<5;
const coord=i=>String.fromCharCode(65+Math.floor(i/5))+(i%5+1);
const other=p=>3-p;

function popcnt32(x){
  x>>>=0;
  x=x-((x>>>1)&0x55555555);
  x=(x&0x33333333)+((x>>>2)&0x33333333);
  return (((x+(x>>>4))&0x0F0F0F0F)*0x01010101)>>>24;
}
function bitsOf(mask){
  const out=[]; mask>>>=0;
  while(mask){
    const lsb=(mask&-mask)>>>0;
    const i=31-Math.clz32(lsb);
    out.push(i);
    mask=(mask^lsb)>>>0;
  }
  return out;
}
function mulberry32(a){
  return function(){
    let t=a+=0x6D2B79F5;
    t=Math.imul(t^t>>>15,t|1);
    t^=t+Math.imul(t^t>>>7,t|61);
    return((t^t>>>14)>>>0)/4294967296;
  };
}
function mix32(x){
  x=(x+0x9e3779b9)>>>0;
  x=Math.imul(x^(x>>>16),0x21f0aaad)>>>0;
  x=Math.imul(x^(x>>>15),0x735a2d97)>>>0;
  return (x^(x>>>15))>>>0;
}

const NEI=Array.from({length:25},()=>[]);
const DIRS=[[1,0],[-1,0],[0,1],[0,-1]];
for(let i=0;i<25;i++){
  const[r,c]=rc(i);
  for(const[dr,dc]of DIRS){
    const r2=r+dr,c2=c+dc;
    if(inb(r2,c2))NEI[i].push(idx(r2,c2));
  }
}

// 固定动作编码：25落子 + 25掐子 + 80相邻有向移动 + 1 PASS = 131。
const MOVE_CODE=Array.from({length:25},()=>Array(25).fill(-1));
const CODE_TO_MOVE=new Map();
let nextMoveCode=50;
for(let from=0;from<25;from++){
  for(const to of NEI[from]){
    MOVE_CODE[from][to]=nextMoveCode;
    CODE_TO_MOVE.set(nextMoveCode,{type:'M',from,to,code:nextMoveCode});
    nextMoveCode++;
  }
}
if(nextMoveCode!==130)throw new Error('移动动作编码应为80个，实际 '+(nextMoveCode-50));
const PASS_CODE=130;

function actionCode(a){
  if(a.code!=null)return a.code;
  if(a.type==='P')return a.to;
  if(a.type==='X')return 25+a.to;
  if(a.type==='M')return MOVE_CODE[a.from][a.to];
  return PASS_CODE;
}
function actionText(a){
  if(!a)return'';
  if(a.type==='P')return 'P'+coord(a.to);
  if(a.type==='X')return 'X'+coord(a.to);
  if(a.type==='M')return 'M'+coord(a.from)+'-'+coord(a.to);
  return 'PASS';
}

function maskOf(cells){let m=0;for(const i of cells)m=(m|bit(i))>>>0;return m>>>0;}
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

const PATTERNS=[];
function addPatterns(type,score,arr){for(const cells of arr)PATTERNS.push({id:PATTERNS.length,type,score,cells,mask:maskOf(cells)});}
addPatterns('一方',1,TSQ);
addPatterns('三步',1,T3);
addPatterns('四步',1,T4);
addPatterns('五龙',2,TDR);
addPatterns('一溜',2,TLI);
if(PATTERNS.length!==32)throw new Error('棋型应为32个，实际 '+PATTERNS.length);

const IDS_BY_TYPE={};
for(const p of PATTERNS)(IDS_BY_TYPE[p.type]??=[]).push(p.id);
function contained(small,big){return small.cells.every(i=>big.cells.includes(i));}
const CONTAINING_LI=Array.from({length:32},()=>[]);
const CONTAINING_FOUR=Array.from({length:32},()=>[]);
for(const p of PATTERNS){
  if(p.type==='三步'||p.type==='四步'){
    for(const q of PATTERNS)if(q.type==='一溜'&&contained(p,q))CONTAINING_LI[p.id].push(q.id);
  }
  if(p.type==='三步'){
    for(const q of PATTERNS)if(q.type==='四步'&&contained(p,q))CONTAINING_FOUR[p.id].push(q.id);
  }
}
const CENTER_W=[0,1,2,1,0,1,3,5,3,1,2,5,8,5,2,1,3,5,3,1,0,1,2,1,0];

function newState(){
  return{
    blackMask:0,whiteMask:0,
    owner:new Uint8Array(25),
    pid:new Uint8Array(25),
    nextId1:1,nextId2:1,
    claimed1:new Set(),claimed2:new Set(),
    claimHash1:0,claimHash2:0,idHash:0,
    phase:PHASE.PLACE,turn:1,bonusLeft:0,captureLeft:0,openingStage:0,
    winner:0,winReason:''
  };
}
function playerMask(s,p){return p===1?s.blackMask:s.whiteMask;}
function claimedSet(s,p){return p===1?s.claimed1:s.claimed2;}
function ownerAt(s,i){return s.owner[i];}
function countPieces(s,p){return popcnt32(playerMask(s,p));}

function idCellHash(i,p,id){return mix32((i+1)*0x45d9f3b ^ p*0x119de1f3 ^ id*0x27d4eb2d);}
function claimHash(sig){return mix32((sig ^ Math.floor(sig/4294967296))>>>0);}
function setCell(s,i,p,id){
  const oldP=s.owner[i],oldId=s.pid[i];
  if(oldP){
    s.idHash=(s.idHash^idCellHash(i,oldP,oldId))>>>0;
    if(oldP===1)s.blackMask=(s.blackMask&~bit(i))>>>0;
    else s.whiteMask=(s.whiteMask&~bit(i))>>>0;
  }
  s.owner[i]=p||0;s.pid[i]=id||0;
  if(p){
    if(p===1)s.blackMask=(s.blackMask|bit(i))>>>0;
    else s.whiteMask=(s.whiteMask|bit(i))>>>0;
    s.idHash=(s.idHash^idCellHash(i,p,id))>>>0;
  }
}
function patternSig(s,pat){
  // patternId占高位，最多5个棋子ID，每个5 bit。整个值 < 2^31，Number精确。
  let pack=0,shift=0;
  for(const i of pat.cells){pack+=Number(s.pid[i])*(2**shift);shift+=5;}
  return pat.id*(2**25)+pack;
}
function addClaim(s,p,sig){
  const set=claimedSet(s,p);
  if(set.has(sig))return false;
  set.add(sig);
  if(p===1)s.claimHash1=(s.claimHash1^claimHash(sig))>>>0;
  else s.claimHash2=(s.claimHash2^claimHash(sig))>>>0;
  return true;
}
function deleteClaim(s,p,sig){
  const set=claimedSet(s,p);
  if(!set.delete(sig))return;
  if(p===1)s.claimHash1=(s.claimHash1^claimHash(sig))>>>0;
  else s.claimHash2=(s.claimHash2^claimHash(sig))>>>0;
}

function fullPatternIds(s,p){
  const pm=playerMask(s,p),full=Array(32).fill(false);
  for(const pat of PATTERNS)full[pat.id]=((pm&pat.mask)>>>0)===pat.mask;
  const out=[];
  for(const pat of PATTERNS){
    if(!full[pat.id])continue;
    if(pat.type==='四步'&&CONTAINING_LI[pat.id].some(id=>full[id]))continue;
    if(pat.type==='三步'&&(CONTAINING_LI[pat.id].some(id=>full[id])||CONTAINING_FOUR[pat.id].some(id=>full[id])))continue;
    out.push(pat.id);
  }
  return out;
}
function rawPatterns(s,p){return fullPatternIds(s,p).map(id=>PATTERNS[id]);}
function protectedMask(s,p){
  let m=0;for(const id of fullPatternIds(s,p))m=(m|PATTERNS[id].mask)>>>0;return m>>>0;
}
function newPatternClaims(s,p){
  const set=claimedSet(s,p),out=[];
  for(const id of fullPatternIds(s,p)){
    const pat=PATTERNS[id],sig=patternSig(s,pat);
    if(!set.has(sig))out.push({pat,sig});
  }
  return out;
}
function looseMask(s,target){
  return (playerMask(s,target)&~protectedMask(s,target))>>>0;
}
function legalMoveCount(s,p){
  const mine=playerMask(s,p),occ=(s.blackMask|s.whiteMask)>>>0;
  let n=0;
  for(const from of bitsOf(mine))for(const to of NEI[from])if((occ&bit(to))===0)n++;
  return n;
}
function terminal(s){
  if(s.winner)return;
  if(s.blackMask===0){s.winner=2;s.winReason='captured';s.phase=PHASE.GAMEOVER;return;}
  if(s.whiteMask===0){s.winner=1;s.winReason='captured';s.phase=PHASE.GAMEOVER;return;}
  if(s.phase===PHASE.MOVE&&legalMoveCount(s,s.turn)===0){
    s.winner=other(s.turn);s.winReason='stuck';s.phase=PHASE.GAMEOVER;
  }
}
function actions(s){
  if(s.winner)return[];
  const out=[];
  const occ=(s.blackMask|s.whiteMask)>>>0;
  if(s.phase===PHASE.PLACE){
    for(let i=0;i<25;i++)if((occ&bit(i))===0)out.push({type:'P',to:i,code:i});
    return out;
  }
  if(s.phase===PHASE.OPENING){
    const lm=looseMask(s,other(s.turn));
    if(!lm)return[{type:'S',code:PASS_CODE}];
    for(const i of bitsOf(lm))out.push({type:'X',to:i,opening:true,code:25+i});
    return out;
  }
  if(s.phase===PHASE.MOVE){
    const mine=playerMask(s,s.turn);
    for(const from of bitsOf(mine))for(const to of NEI[from])if((occ&bit(to))===0)out.push({type:'M',from,to,code:MOVE_CODE[from][to]});
    return out;
  }
  if(s.phase===PHASE.CAPTURE){
    const lm=looseMask(s,other(s.turn));
    if(!lm)return[{type:'S',code:PASS_CODE}];
    for(const i of bitsOf(lm))out.push({type:'X',to:i,code:25+i});
    return out;
  }
  return out;
}

function remember(undo,s,i){
  if(undo.changedMap.has(i))return;
  undo.changedMap.set(i,{owner:s.owner[i],pid:s.pid[i]});
}
function makeMove(s,a){
  const undo={
    blackMask:s.blackMask,whiteMask:s.whiteMask,idHash:s.idHash,
    claimHash1:s.claimHash1,claimHash2:s.claimHash2,
    nextId1:s.nextId1,nextId2:s.nextId2,
    phase:s.phase,turn:s.turn,bonusLeft:s.bonusLeft,captureLeft:s.captureLeft,openingStage:s.openingStage,
    winner:s.winner,winReason:s.winReason,
    changedMap:new Map(),added1:[],added2:[],
    reward:0,formed:0,endedTurn:false,critical:false
  };
  const p=s.turn,beforeTurn=s.turn;
  if(a.type==='P'){
    if(s.bonusLeft>0)s.bonusLeft--;
    remember(undo,s,a.to);
    const id=p===1?s.nextId1++:s.nextId2++;
    setCell(s,a.to,p,id);
    const np=newPatternClaims(s,p);
    let g=0;
    for(const x of np)if(addClaim(s,p,x.sig)){(p===1?undo.added1:undo.added2).push(x.sig);g+=x.pat.score;undo.formed++;}
    undo.reward=g;s.bonusLeft+=g;
    if(popcnt32((s.blackMask|s.whiteMask)>>>0)===25){
      s.phase=PHASE.OPENING;s.turn=2;s.openingStage=0;s.bonusLeft=0;
    }else if(s.bonusLeft===0)s.turn=other(p);
  }else if(a.type==='X'&&s.phase===PHASE.OPENING){
    remember(undo,s,a.to);setCell(s,a.to,0,0);
    if(s.openingStage===0){s.openingStage=1;s.turn=1;}
    else{s.phase=PHASE.MOVE;s.turn=2;s.openingStage=2;terminal(s);}
  }else if(a.type==='S'&&s.phase===PHASE.OPENING){
    if(s.openingStage===0){s.openingStage=1;s.turn=1;}
    else{s.phase=PHASE.MOVE;s.turn=2;s.openingStage=2;terminal(s);}
  }else if(a.type==='M'){
    const id=s.pid[a.from];
    remember(undo,s,a.from);remember(undo,s,a.to);
    setCell(s,a.from,0,0);setCell(s,a.to,p,id);
    const np=newPatternClaims(s,p);
    let g=0;
    for(const x of np)if(addClaim(s,p,x.sig)){(p===1?undo.added1:undo.added2).push(x.sig);g+=x.pat.score;undo.formed++;}
    undo.reward=g;
    if(g>0&&looseMask(s,other(p))){
      s.phase=PHASE.CAPTURE;s.captureLeft=g;
    }else{
      s.phase=PHASE.MOVE;s.captureLeft=0;s.turn=other(p);terminal(s);
    }
  }else if(a.type==='X'&&s.phase===PHASE.CAPTURE){
    remember(undo,s,a.to);setCell(s,a.to,0,0);s.captureLeft--;terminal(s);
    if(!s.winner&&(s.captureLeft<=0||!looseMask(s,other(p)))){
      s.captureLeft=0;s.phase=PHASE.MOVE;s.turn=other(p);terminal(s);
    }
  }else if(a.type==='S'&&s.phase===PHASE.CAPTURE){
    s.captureLeft=0;s.phase=PHASE.MOVE;s.turn=other(p);terminal(s);
  }else throw new Error('非法动作/阶段 '+JSON.stringify(a)+' phase='+s.phase);

  undo.endedTurn=!!s.winner||s.turn!==beforeTurn;
  // 真战术节点定义：终局、掐子、刚成型、或把对方压到<=1条路。
  undo.critical=!!s.winner||a.type==='X'||undo.reward>0;
  if(!undo.critical&&undo.endedTurn&&s.phase===PHASE.MOVE&&!s.winner&&legalMoveCount(s,s.turn)<=1)undo.critical=true;
  return undo;
}
function unmakeMove(s,undo){
  for(const sig of undo.added1)s.claimed1.delete(sig);
  for(const sig of undo.added2)s.claimed2.delete(sig);
  for(const [i,v] of undo.changedMap){s.owner[i]=v.owner;s.pid[i]=v.pid;}
  s.blackMask=undo.blackMask;s.whiteMask=undo.whiteMask;s.idHash=undo.idHash;
  s.claimHash1=undo.claimHash1;s.claimHash2=undo.claimHash2;
  s.nextId1=undo.nextId1;s.nextId2=undo.nextId2;
  s.phase=undo.phase;s.turn=undo.turn;s.bonusLeft=undo.bonusLeft;s.captureLeft=undo.captureLeft;s.openingStage=undo.openingStage;
  s.winner=undo.winner;s.winReason=undo.winReason;
}

function canonicalState(s){
  return JSON.stringify({
    black:s.blackMask>>>0,white:s.whiteMask>>>0,
    owner:[...s.owner],pid:[...s.pid],
    nextId1:s.nextId1,nextId2:s.nextId2,
    claimed1:[...s.claimed1].sort((a,b)=>a-b),claimed2:[...s.claimed2].sort((a,b)=>a-b),
    claimHash1:s.claimHash1>>>0,claimHash2:s.claimHash2>>>0,idHash:s.idHash>>>0,
    phase:s.phase,turn:s.turn,bonus:s.bonusLeft,cap:s.captureLeft,open:s.openingStage,w:s.winner,r:s.winReason
  });
}
function hashState(s){
  let h1=0x811c9dc5>>>0,h2=0x9e3779b9>>>0;
  const vals=[
    s.blackMask>>>0,s.whiteMask>>>0,s.idHash>>>0,s.claimHash1>>>0,s.claimHash2>>>0,
    s.phase,s.turn,s.bonusLeft,s.captureLeft,s.openingStage,s.nextId1,s.nextId2
  ];
  for(let i=0;i<vals.length;i++){
    h1=mix32(h1^vals[i]^Math.imul(i+1,0x45d9f3b));
    h2=mix32(h2^vals[i]^Math.imul(i+7,0x27d4eb2d));
  }
  return h1.toString(16).padStart(8,'0')+h2.toString(16).padStart(8,'0');
}
function repetitionKey(s){
  // 官方重复判定只在稳定 move 阶段使用；完整棋盘+ID+turn+claimed 已进入 hash。
  return hashState(s);
}

const FALLBACK_BASE_W={material:80.8132,mobility:30,protected:4.2116,pattern:18.7737,potential:5,center:8};
function loadBase(){
  try{
    const x=JSON.parse(fs.readFileSync('data/ai-baseline.json','utf8'));
    const w=x.weights||{};
    const keys=['material','mobility','protected','pattern','potential','center'];
    if(keys.every(k=>Number.isFinite(Number(w[k])))){
      return{
        generation:Number(x.generation)||0,
        weights:Object.fromEntries(keys.map(k=>[k,Number(w[k])]))
      };
    }
  }catch{}
  return{generation:4,weights:{...FALLBACK_BASE_W}};
}
const LOADED_BASE=loadBase();
const BASE_W=LOADED_BASE.weights;
function patternPotential(s,p){
  let sc=0,pm=playerMask(s,p),om=playerMask(s,other(p));
  for(const t of PATTERNS){
    const me=popcnt32((pm&t.mask)>>>0),opp=popcnt32((om&t.mask)>>>0),n=t.cells.length;
    if(opp===0){
      if(me===n)sc+=18*t.score;
      else if(me===n-1)sc+=11*t.score;
      else if(me===n-2)sc+=3.5*t.score;
    }
  }
  return sc;
}
function evalBlack(s){
  if(s.winner)return s.winner===1?1e8:-1e8;
  const material=countPieces(s,1)-countPieces(s,2);
  const mobility=legalMoveCount(s,1)-legalMoveCount(s,2);
  const protectedDiff=popcnt32(protectedMask(s,1))-popcnt32(protectedMask(s,2));
  const patternDiff=rawPatterns(s,1).reduce((z,p)=>z+p.score,0)-rawPatterns(s,2).reduce((z,p)=>z+p.score,0);
  const potential=patternPotential(s,1)-patternPotential(s,2);
  let center=0;
  for(let i=0;i<25;i++)if(s.owner[i])center+=(s.owner[i]===1?1:-1)*CENTER_W[i];
  return material*BASE_W.material+mobility*BASE_W.mobility+protectedDiff*BASE_W.protected+
         patternDiff*BASE_W.pattern+potential*BASE_W.potential+center*BASE_W.center;
}
function evalFor(s,root){const v=evalBlack(s);return root===1?v:-v;}

function pushDraw(before,a,s,undo,noProgress,rep){
  let np=noProgress;
  if(a.type==='X')np=0;
  else if(a.type==='M')np=undo.reward>0?0:np+1;
  let key=null,prev=0,draw=false;
  if(!s.winner&&s.phase===PHASE.MOVE){
    key=repetitionKey(s);prev=rep.get(key)||0;rep.set(key,prev+1);
    if(prev+1>=3||np>=100)draw=true;
  }
  return{np,key,prev,draw,sensitive:np>=92||prev>=1};
}
function popDraw(step,rep){
  if(step.key==null)return;
  if(step.prev>0)rep.set(step.key,step.prev);else rep.delete(step.key);
}
function anyRepSensitive(rep){for(const v of rep.values())if(v>=2)return true;return false;}

function orderMoves(s,root,ctx,ttMove,ply){
  const aa=actions(s);
  if(aa.length<=1)return aa;
  const maximizing=s.turn===root;
  const scored=[];
  for(const a of aa){
    let v=0,code=actionCode(a);
    if(code===ttMove)v+=1e9;
    if(ctx.killers[ply]?.includes(code))v+=3e7;
    v+=(ctx.history[code]||0);
    if(a.type==='X')v+=5e7;
    if(a.type==='P')v+=CENTER_W[a.to]*500;
    if(a.type==='M')v+=(CENTER_W[a.to]-CENTER_W[a.from])*250;
    const u=makeMove(s,a);
    if(s.winner===root)v+=8e8;
    if(s.winner===other(root))v-=8e8;
    if(u.reward>0)v+=(maximizing?1:-1)*u.reward*8e7;
    if(u.endedTurn&&!s.winner&&s.phase===PHASE.MOVE){
      const lm=legalMoveCount(s,s.turn);
      if(lm===1)v+=(maximizing?1:-1)*2e7;
      if(lm===0)v+=(maximizing?1:-1)*7e8;
    }
    unmakeMove(s,u);
    scored.push({a,v});
  }
  scored.sort((x,y)=>maximizing?y.v-x.v:x.v-y.v);
  return scored.map(x=>x.a);
}

function qsearch(s,alpha,beta,root,ctx,noProgress,rep,qLeft,ply,sensitive){
  ctx.qnodes++;ctx.nodes++;
  if(ctx.nodes>=ctx.nodeLimit||(ctx.deadline&&Date.now()>=ctx.deadline)){ctx.aborted=true;return evalFor(s,root);}
  if(s.winner)return evalFor(s,root);
  let stand=evalFor(s,root);
  if(qLeft<=0)return stand;
  const maximizing=s.turn===root;
  let best=stand;
  if(maximizing){if(best>=beta)return best;if(best>alpha)alpha=best;}
  else{if(best<=alpha)return best;if(best<beta)beta=best;}

  const tactical=[];
  for(const a of actions(s)){
    const u=makeMove(s,a);
    if(u.critical)tactical.push({a,rank:(s.winner?1e9:0)+(a.type==='X'?1e7:0)+u.reward*1e6});
    unmakeMove(s,u);
  }
  tactical.sort((a,b)=>b.rank-a.rank);
  for(const x of tactical.slice(0,6)){
    const u=makeMove(s,x.a),step=pushDraw(null,x.a,s,u,noProgress,rep);
    let v;
    if(step.draw){v=0;ctx.drawLeaves++;}
    else v=qsearch(s,alpha,beta,root,ctx,step.np,rep,qLeft-1,ply+1,sensitive||step.sensitive);
    popDraw(step,rep);unmakeMove(s,u);
    if(ctx.aborted)return evalFor(s,root);
    if(maximizing){
      if(v>best)best=v;if(best>alpha)alpha=best;if(alpha>=beta)break;
    }else{
      if(v<best)best=v;if(best<beta)beta=best;if(alpha>=beta)break;
    }
  }
  return best;
}

function ttKey(s,root){return hashState(s)+'|r'+root;}
function pvs(s,depth,alpha,beta,root,ctx,noProgress,rep,extLeft,ply,sensitive){
  ctx.nodes++;
  if(ctx.nodes>=ctx.nodeLimit||(ctx.deadline&&Date.now()>=ctx.deadline)){ctx.aborted=true;return evalFor(s,root);}
  if(s.winner)return evalFor(s,root);
  if(depth<=0)return ctx.useQ?qsearch(s,alpha,beta,root,ctx,noProgress,rep,ctx.qDepth,ply,sensitive):evalFor(s,root);

  const historySensitive=sensitive||noProgress>=92||anyRepSensitive(rep);
  const key=historySensitive?null:ttKey(s,root);
  const old=key?ctx.tt.get(key):null;
  let ttMove=-1;
  const alpha0=alpha,beta0=beta;
  if(old){
    ttMove=old.bestCode;
    if(old.depth>=depth){
      if(old.flag==='EXACT')return old.score;
      if(old.flag==='LOWER')alpha=Math.max(alpha,old.score);
      else if(old.flag==='UPPER')beta=Math.min(beta,old.score);
      if(alpha>=beta)return old.score;
    }
  }

  const aa=orderMoves(s,root,ctx,ttMove,ply);
  if(!aa.length)return evalFor(s,root);
  const maximizing=s.turn===root;
  let best=maximizing?-Infinity:Infinity,bestCode=-1,first=true;

  for(const a of aa){
    const code=actionCode(a),u=makeMove(s,a);
    const step=pushDraw(null,a,s,u,noProgress,rep);
    let v;
    if(step.draw){v=0;ctx.drawLeaves++;}
    else{
      const cost=u.endedTurn?1:0;
      let nd=depth-cost,nextExt=extLeft;
      // 真正延伸：如果这一步结束了一个战术回合（掐子/困弊边缘/终结变化），回补一层。
      if(cost===1&&u.critical&&extLeft>0){nd++;nextExt--;ctx.extensions++;}
      const childSensitive=historySensitive||step.sensitive;
      if(first){
        v=pvs(s,nd,alpha,beta,root,ctx,step.np,rep,nextExt,ply+1,childSensitive);
      }else if(maximizing){
        v=pvs(s,nd,alpha,alpha+1,root,ctx,step.np,rep,nextExt,ply+1,childSensitive);
        if(!ctx.aborted&&v>alpha&&v<beta)v=pvs(s,nd,alpha,beta,root,ctx,step.np,rep,nextExt,ply+1,childSensitive);
      }else{
        v=pvs(s,nd,beta-1,beta,root,ctx,step.np,rep,nextExt,ply+1,childSensitive);
        if(!ctx.aborted&&v<beta&&v>alpha)v=pvs(s,nd,alpha,beta,root,ctx,step.np,rep,nextExt,ply+1,childSensitive);
      }
    }
    popDraw(step,rep);unmakeMove(s,u);
    if(ctx.aborted)return evalFor(s,root);
    first=false;
    if(maximizing){
      if(v>best){best=v;bestCode=code;}
      if(best>alpha)alpha=best;
    }else{
      if(v<best){best=v;bestCode=code;}
      if(best<beta)beta=best;
    }
    if(alpha>=beta){
      if(a.type==='M'||a.type==='P'){
        const ks=ctx.killers[ply]||(ctx.killers[ply]=[]);
        if(!ks.includes(code)){ks.unshift(code);if(ks.length>2)ks.pop();}
        ctx.history[code]=(ctx.history[code]||0)+depth*depth*64;
      }
      break;
    }
  }
  if(key&&!ctx.aborted&&Number.isFinite(best)){
    let flag='EXACT';
    if(best<=alpha0)flag='UPPER';else if(best>=beta0)flag='LOWER';
    ctx.tt.set(key,{depth,score:best,flag,bestCode});
  }
  return best;
}

function searchV8(s,targetDepth,root,opts={}){
  const tt=new Map(),history=new Int32Array(131),killers=[];
  const rep=new Map(opts.rep||[]);
  const noProgress=opts.noProgress||0;
  let completed=null,totalNodes=0,totalQ=0,totalExt=0,totalDraw=0;
  const nodeLimit=opts.nodeLimit??8_000_000;
  const deadline=opts.maxMs?Date.now()+opts.maxMs:0;
  for(let d=1;d<=targetDepth;d++){
    const ctx={
      tt,history,killers,nodes:0,qnodes:0,extensions:0,drawLeaves:0,aborted:false,
      nodeLimit,deadline,useQ:opts.useQ!==false,qDepth:opts.qDepth??2
    };
    const aa=orderMoves(s,root,ctx,completed?.bestCode??-1,0);
    const ranked=[];
    let alpha=-Infinity,beta=Infinity;
    const maximizing=s.turn===root;
    for(const a of aa){
      const u=makeMove(s,a),step=pushDraw(null,a,s,u,noProgress,rep);
      let v;
      if(step.draw){v=0;ctx.drawLeaves++;}
      else{
        let nd=d-(u.endedTurn?1:0),extLeft=opts.extensions??1;
        if(u.endedTurn&&u.critical&&extLeft>0){nd++;extLeft--;ctx.extensions++;}
        v=pvs(s,nd,-Infinity,Infinity,root,ctx,step.np,rep,extLeft,1,step.sensitive);
      }
      popDraw(step,rep);unmakeMove(s,u);
      ranked.push({a,score:v,code:actionCode(a)});
      if(ctx.aborted)break;
    }
    totalNodes+=ctx.nodes;totalQ+=ctx.qnodes;totalExt+=ctx.extensions;totalDraw+=ctx.drawLeaves;
    if(ctx.aborted||ranked.length!==aa.length)break;
    ranked.sort((x,y)=>maximizing?y.score-x.score:x.score-y.score);
    completed={depth:d,action:ranked[0].a,bestCode:ranked[0].code,score:ranked[0].score,ranked};
  }
  if(!completed){
    const aa=actions(s);const a=aa[0]||null;
    return{action:a,bestCode:a?actionCode(a):-1,score:evalFor(s,root),depth:0,ranked:[],nodes:totalNodes,qnodes:totalQ,extensions:totalExt,drawLeaves:totalDraw,aborted:true};
  }
  return{...completed,nodes:totalNodes,qnodes:totalQ,extensions:totalExt,drawLeaves:totalDraw,aborted:false};
}

function oracleNode(s,depth,alpha,beta,root,ctx,noProgress,rep){
  ctx.nodes++;
  if(s.winner||depth<=0)return evalFor(s,root);
  const aa=actions(s);
  if(!aa.length)return evalFor(s,root);
  const maximizing=s.turn===root;
  let best=maximizing?-Infinity:Infinity;
  for(const a of aa){
    const u=makeMove(s,a),step=pushDraw(null,a,s,u,noProgress,rep);
    let v;
    if(step.draw)v=0;
    else v=oracleNode(s,depth-(u.endedTurn?1:0),alpha,beta,root,ctx,step.np,rep);
    popDraw(step,rep);unmakeMove(s,u);
    if(maximizing){if(v>best)best=v;if(best>alpha)alpha=best;}
    else{if(v<best)best=v;if(best<beta)beta=best;}
    if(alpha>=beta)break;
  }
  return best;
}
function oracleSearch(s,depth,root,opts={}){
  const rep=new Map(opts.rep||[]),noProgress=opts.noProgress||0,ctx={nodes:0};
  const maximizing=s.turn===root,ranked=[];
  for(const a of actions(s)){
    const u=makeMove(s,a),step=pushDraw(null,a,s,u,noProgress,rep);
    const v=step.draw?0:oracleNode(s,depth-(u.endedTurn?1:0),-Infinity,Infinity,root,ctx,step.np,rep);
    popDraw(step,rep);unmakeMove(s,u);
    ranked.push({a,score:v,code:actionCode(a)});
  }
  ranked.sort((x,y)=>maximizing?y.score-x.score:x.score-y.score);
  return{action:ranked[0]?.a||null,score:ranked[0]?.score??evalFor(s,root),ranked,nodes:ctx.nodes};
}

function randomPlayout(seed,plies){
  const rng=mulberry32(seed>>>0),s=newState(),rep=new Map();let noProgress=0;
  if(s.phase===PHASE.MOVE)rep.set(repetitionKey(s),1);
  for(let n=0;n<plies&&!s.winner;n++){
    const aa=actions(s);if(!aa.length)break;
    const a=aa[Math.floor(rng()*aa.length)];
    const u=makeMove(s,a),step=pushDraw(null,a,s,u,noProgress,rep);
    noProgress=step.np;
    if(step.draw)break;
    // 实战历史永久保留，不 pop。
  }
  return{s,rep,noProgress};
}
function stateFromPieces(entries){
  const s=newState();s.phase=PHASE.MOVE;s.turn=1;
  let n1=1,n2=1;
  for(const [i,p] of entries)setCell(s,i,p,p===1?n1++:n2++);
  s.nextId1=n1;s.nextId2=n2;
  return s;
}

function assert(cond,msg){if(!cond)throw new Error(msg);}
function runRuleTests(){
  let tests=0;
  // 三步必须是指定端点到边界的四条。
  let s=stateFromPieces([[idx(0,2),1],[idx(1,1),1],[idx(2,0),1]]);
  assert(rawPatterns(s,1).some(x=>x.type==='三步'),'A3-B2-C1 应识别为三步');tests++;
  s=stateFromPieces([[idx(1,0),1],[idx(2,1),1],[idx(3,2),1]]);
  assert(!rawPatterns(s,1).some(x=>x.type==='三步'),'B1-C2-D3 不应误判三步');tests++;
  s=stateFromPieces([[idx(0,1),1],[idx(1,2),1],[idx(2,3),1],[idx(3,4),1]]);
  assert(rawPatterns(s,1).some(x=>x.type==='四步'),'A2-B3-C4-D5 应识别四步');tests++;
  s=stateFromPieces([[idx(1,0),1],[idx(1,1),1],[idx(1,2),1],[idx(1,3),1],[idx(1,4),1]]);
  assert(rawPatterns(s,1).some(x=>x.type==='一溜'),'内部B行五子应识别一溜');tests++;
  s=stateFromPieces([[idx(0,0),1],[idx(0,1),1],[idx(0,2),1],[idx(0,3),1],[idx(0,4),1]]);
  assert(!rawPatterns(s,1).some(x=>x.type==='一溜'),'外边A行五子不能算一溜');tests++;
  assert(actions(newState()).length===25,'初始应有25个落点');tests++;
  assert(PATTERNS.length===32,'固定棋型总数应为32');tests++;
  assert(nextMoveCode-50===80,'有向相邻移动总数应为80');tests++;
  return tests;
}
function runMakeUnmakeTests(seed=20260914){
  let checks=0;
  for(let k=0;k<24;k++){
    const {s}=randomPlayout((seed+k*9973)>>>0,4+(k*7)%42);
    if(s.winner)continue;
    const before=canonicalState(s),aa=actions(s).slice(0,Math.min(12,actions(s).length));
    for(const a of aa){
      const u=makeMove(s,a);unmakeMove(s,u);
      assert(canonicalState(s)===before,'make/unmake 不可逆：'+actionText(a));checks++;
    }
  }
  return checks;
}
function runOracleAgreement(seed=20260914,depth=2){
  const rows=[];let ok=0,total=0,oracleNodes=0,v8Nodes=0;
  for(let k=0;k<14;k++){
    const p=randomPlayout((seed+0x51ed270b+k*2654435761)>>>0,5+(k*5)%34);
    const s=p.s;if(s.winner||actions(s).length===0)continue;
    const root=s.turn;
    const o=oracleSearch(s,depth,root,{rep:p.rep,noProgress:p.noProgress});
    // 对裁判一致性测试关闭静态搜索/延伸，保证只验证 PVS/TT/排序，不混入搜索语义变化。
    const v=searchV8(s,depth,root,{rep:p.rep,noProgress:p.noProgress,useQ:false,extensions:0,nodeLimit:20_000_000});
    oracleNodes+=o.nodes;v8Nodes+=v.nodes;total++;
    const target=o.score;
    const vScore=v.score;
    const sameScore=Math.abs(target-vScore)<1e-7;
    const validBest=o.ranked.filter(x=>Math.abs(x.score-target)<1e-7).map(x=>x.code);
    const sameBest=validBest.includes(v.bestCode);
    if(sameScore&&sameBest)ok++;
    rows.push({
      k,phase:PHASE_NAME[s.phase],turn:s.turn,legal:actions(s).length,
      oracle:actionText(o.action),v8:actionText(v.action),
      score:Number(target.toFixed(3)),sameScore,sameBest,oracleNodes:o.nodes,v8Nodes:v.nodes
    });
  }
  assert(total>=8,'可测试局面太少');
  assert(ok===total,`PVS 与 Oracle 不一致：${ok}/${total}`);
  return{ok,total,oracleNodes,v8Nodes,rows};
}
function runExtensionProof(seed=20260914){
  let found=0,totalExt=0,totalQ=0;
  const samples=[];
  for(let k=0;k<20;k++){
    const p=randomPlayout((seed+0x9e3779b9+k*104729)>>>0,18+(k*3)%28);
    if(p.s.winner||actions(p.s).length===0)continue;
    const v=searchV8(p.s,2,p.s.turn,{rep:p.rep,noProgress:p.noProgress,useQ:true,extensions:1,nodeLimit:3_000_000});
    totalExt+=v.extensions;totalQ+=v.qnodes;
    if(v.extensions>0){found++;if(samples.length<6)samples.push({phase:PHASE_NAME[p.s.phase],best:actionText(v.action),extensions:v.extensions,qnodes:v.qnodes,nodes:v.nodes});}
  }
  // 不是要求每个随机样本都有战术，而是确认真延伸路径确实被调用过。
  assert(totalExt>0,'未触发任何真正战术延伸');
  assert(totalQ>0,'未触发静态战术搜索');
  return{found,totalExt,totalQ,samples};
}
function runBench(seed=20260914,depth=3){
  const rows=[];
  for(let k=0;k<8;k++){
    const p=randomPlayout((seed+k*811)>>>0,14+(k*4)%24);
    if(p.s.winner||actions(p.s).length===0)continue;
    const t0=Date.now();
    const v=searchV8(p.s,depth,p.s.turn,{rep:p.rep,noProgress:p.noProgress,useQ:true,extensions:1,nodeLimit:8_000_000});
    rows.push({k,phase:PHASE_NAME[p.s.phase],legal:actions(p.s).length,best:actionText(v.action),depth:v.depth,nodes:v.nodes,qnodes:v.qnodes,ext:v.extensions,ms:Date.now()-t0});
  }
  return rows;
}


// ---------------- V8-C：纯搜索器擂台 ----------------
// 目的：先不引入 NNUE / Policy / 开局库，只比较“搜索方法”本身。
// 两边共用同一个 Bitboard 规则核心和 Gen4 正式评价函数，避免规则/评价差异污染结果。
// Gen4 兼容侧复刻旧搜索的关键特征：硬分支上限 + 普通 Alpha-Beta + TT，无静态战术延伸、无和棋历史感知。
function cloneStateFast(s){
  return{
    blackMask:s.blackMask>>>0,whiteMask:s.whiteMask>>>0,
    owner:new Uint8Array(s.owner),pid:new Uint8Array(s.pid),
    nextId1:s.nextId1,nextId2:s.nextId2,
    claimed1:new Set(s.claimed1),claimed2:new Set(s.claimed2),
    claimHash1:s.claimHash1>>>0,claimHash2:s.claimHash2>>>0,idHash:s.idHash>>>0,
    phase:s.phase,turn:s.turn,bonusLeft:s.bonusLeft,captureLeft:s.captureLeft,openingStage:s.openingStage,
    winner:s.winner,winReason:s.winReason
  };
}
function legacyQuickScore(s,a,root){
  const actor=s.turn,u=makeMove(s,a);
  let z=evalFor(s,root);
  if(a.type==='X')z+=280;
  if(a.type==='P')z+=CENTER_W[a.to]*4;
  if(a.type==='M'){
    z+=(CENTER_W[a.to]-CENTER_W[a.from])*2;
    if(s.phase===PHASE.CAPTURE&&s.turn===actor)z+=180+s.captureLeft*50;
  }
  unmakeMove(s,u);
  return z;
}
function legacyBranchCap(s,depth){
  if(s.phase===PHASE.PLACE)return depth>=4?7:9;
  if(s.phase===PHASE.MOVE)return depth>=4?9:12;
  if(s.phase===PHASE.CAPTURE||s.phase===PHASE.OPENING)return 10;
  return 12;
}
function legacyOrderedActions(s,root,depth){
  const aa=actions(s);
  if(aa.length<=1)return aa;
  const maximizing=s.turn===root;
  const rows=aa.map(a=>({a,v:legacyQuickScore(s,a,root)}));
  rows.sort((x,y)=>maximizing?y.v-x.v:x.v-y.v);
  return rows.slice(0,legacyBranchCap(s,depth)).map(x=>x.a);
}
function legacyAB(s,depth,alpha,beta,root,ctx){
  ctx.nodes++;
  if(ctx.nodes>=ctx.nodeLimit||(ctx.deadline&&Date.now()>=ctx.deadline)){ctx.aborted=true;return evalFor(s,root);}
  if(s.winner||depth<=0)return evalFor(s,root);
  const key=hashState(s)+'|d'+depth+'|r'+root;
  const old=ctx.tt.get(key),alpha0=alpha,beta0=beta;
  if(old){
    if(old.flag==='EXACT')return old.score;
    if(old.flag==='LOWER')alpha=Math.max(alpha,old.score);
    else if(old.flag==='UPPER')beta=Math.min(beta,old.score);
    if(alpha>=beta)return old.score;
  }
  const aa=legacyOrderedActions(s,root,depth);
  if(!aa.length)return evalFor(s,root);
  const maximizing=s.turn===root;
  let best=maximizing?-Infinity:Infinity,bestCode=-1;
  for(const a of aa){
    const u=makeMove(s,a);
    const nd=depth-(u.endedTurn?1:0);
    const v=legacyAB(s,nd,alpha,beta,root,ctx);
    unmakeMove(s,u);
    if(ctx.aborted)return evalFor(s,root);
    if(maximizing){if(v>best){best=v;bestCode=actionCode(a);}if(best>alpha)alpha=best;}
    else{if(v<best){best=v;bestCode=actionCode(a);}if(best<beta)beta=best;}
    if(alpha>=beta)break;
  }
  if(!ctx.aborted&&Number.isFinite(best)){
    let flag='EXACT';
    if(best<=alpha0)flag='UPPER';else if(best>=beta0)flag='LOWER';
    ctx.tt.set(key,{score:best,flag,bestCode});
  }
  return best;
}
function searchLegacy(s,targetDepth,root,opts={}){
  let completed=null,totalNodes=0;
  const nodeLimit=opts.nodeLimit??120000,deadline=opts.maxMs?Date.now()+opts.maxMs:0;
  for(let d=1;d<=targetDepth;d++){
    const ctx={nodes:0,nodeLimit,deadline,aborted:false,tt:new Map()};
    const aa=legacyOrderedActions(s,root,d),ranked=[];
    for(const a of aa){
      const u=makeMove(s,a);
      const v=legacyAB(s,d-(u.endedTurn?1:0),-Infinity,Infinity,root,ctx);
      unmakeMove(s,u);
      ranked.push({a,score:v,code:actionCode(a)});
      if(ctx.aborted)break;
    }
    totalNodes+=ctx.nodes;
    if(ctx.aborted||ranked.length!==aa.length)break;
    ranked.sort((x,y)=>y.score-x.score);
    completed={depth:d,action:ranked[0]?.a||null,bestCode:ranked[0]?.code??-1,score:ranked[0]?.score??evalFor(s,root),ranked};
  }
  if(!completed){
    const aa=legacyOrderedActions(s,root,1),a=aa[0]||null;
    return{action:a,bestCode:a?actionCode(a):-1,score:evalFor(s,root),depth:0,nodes:totalNodes,aborted:true};
  }
  return{...completed,nodes:totalNodes,aborted:false};
}
function arenaNodeBudget(depth){
  if(depth<=2)return 45000;
  if(depth===3)return 120000;
  return 220000;
}
function arenaTimeBudgetMs(depth){
  if(depth<=2)return 140;
  if(depth===3)return 420;
  return 900;
}
function generateArenaScenarios(seed,pairs){
  const out=[];
  for(let attempt=0;out.length<pairs&&attempt<pairs*12;attempt++){
    // 覆盖摆子中后段、满盘过渡、早期走子；同一局面让两台引擎换边各下一盘。
    const plies=10+((attempt*7)%38);
    const p=randomPlayout((seed+0x6a09e667+attempt*2654435761)>>>0,plies);
    if(p.s.winner||actions(p.s).length===0)continue;
    out.push({
      id:out.length,plies,phase:PHASE_NAME[p.s.phase],turn:p.s.turn,
      state:cloneStateFast(p.s),rep:new Map(p.rep),noProgress:p.noProgress,hash:hashState(p.s)
    });
  }
  assert(out.length===pairs,`擂台场景不足：${out.length}/${pairs}`);
  return out;
}
function playArenaGame(sc,v8Side,depth,nodeBudget,timeBudgetMs){
  const s=cloneStateFast(sc.state),rep=new Map(sc.rep);
  let noProgress=sc.noProgress||0,actionsPlayed=0,drawReason='',v8Nodes=0,legacyNodes=0,v8Ext=0,v8Q=0;
  let v8DepthSum=0,v8Calls=0,legacyDepthSum=0,legacyCalls=0;
  while(!s.winner&&!drawReason&&actionsPlayed<320){
    const actor=s.turn;
    let res;
    if(actor===v8Side){
      res=searchV8(s,depth,actor,{rep,noProgress,useQ:true,extensions:1,qDepth:2,nodeLimit:nodeBudget,maxMs:timeBudgetMs});
      v8Nodes+=res.nodes;v8Ext+=res.extensions||0;v8Q+=res.qnodes||0;v8DepthSum+=res.depth||0;v8Calls++;
    }else{
      res=searchLegacy(s,depth,actor,{nodeLimit:nodeBudget,maxMs:timeBudgetMs});
      legacyNodes+=res.nodes;legacyDepthSum+=res.depth||0;legacyCalls++;
    }
    let a=res.action;
    if(!a){const aa=actions(s);a=aa[0]||null;}
    if(!a)break;
    const u=makeMove(s,a),step=pushDraw(null,a,s,u,noProgress,rep);
    noProgress=step.np;actionsPlayed++;
    // 实战推进：历史永久保留，不 popDraw、不 unmake。
    if(step.draw)drawReason=noProgress>=100?'no-progress':'threefold';
  }
  if(!s.winner&&!drawReason&&actionsPlayed>=320)drawReason='safety-cap';
  let result=0;
  if(s.winner)result=s.winner===v8Side?1:-1;
  return{
    result,winner:s.winner||0,drawReason,actions:actionsPlayed,v8Side,
    nodes:{v8:v8Nodes,legacy:legacyNodes},extensions:v8Ext,qnodes:v8Q,
    avgDepth:{v8:v8Calls?Number((v8DepthSum/v8Calls).toFixed(3)):0,legacy:legacyCalls?Number((legacyDepthSum/legacyCalls).toFixed(3)):0}
  };
}
function runArena(seed,depth,games){
  games=Math.max(4,Math.floor(games/2)*2);
  const pairs=games/2,nodeBudget=arenaNodeBudget(depth),timeBudgetMs=arenaTimeBudgetMs(depth),scenarios=generateArenaScenarios(seed,pairs);
  const rows=[];let v8Wins=0,legacyWins=0,draws=0,safety=0,totalV8Nodes=0,totalLegacyNodes=0,totalExt=0,totalQ=0;
  let v8Black={w:0,l:0,d:0},v8White={w:0,l:0,d:0};
  const t0=Date.now();
  for(const sc of scenarios){
    for(const v8Side of [1,2]){
      const g=playArenaGame(sc,v8Side,depth,nodeBudget,timeBudgetMs);
      if(g.result>0){v8Wins++;(v8Side===1?v8Black:v8White).w++;}
      else if(g.result<0){legacyWins++;(v8Side===1?v8Black:v8White).l++;}
      else{draws++;(v8Side===1?v8Black:v8White).d++;}
      if(g.drawReason==='safety-cap')safety++;
      totalV8Nodes+=g.nodes.v8;totalLegacyNodes+=g.nodes.legacy;totalExt+=g.extensions;totalQ+=g.qnodes;
      rows.push({scenario:sc.id,plies:sc.plies,phase:sc.phase,hash:sc.hash,...g});
      console.log(`[v8-lab] arena ${rows.length}/${games}：V8${v8Side===1?'黑':'白'} ${g.result>0?'胜':g.result<0?'负':'和'}；动作${g.actions}；V8深度${g.avgDepth.v8} / 旧深度${g.avgDepth.legacy}`);
    }
  }
  const score=(v8Wins+0.5*draws)/games;
  return{
    version:VERSION,mode:'arena',seed,depth,games,pairs,nodeBudget,timeBudgetMs,
    v8Wins,legacyWins,draws,v8Score:Number(score.toFixed(4)),
    v8Black,v8White,safetyCaps:safety,
    totalNodes:{v8:totalV8Nodes,legacy:totalLegacyNodes},v8Extensions:totalExt,v8QNodes:totalQ,
    elapsedMs:Date.now()-t0,
    scenarios:scenarios.map(x=>({id:x.id,plies:x.plies,phase:x.phase,turn:x.turn,hash:x.hash})),gamesDetail:rows,
    interpretation:'实验擂台：同规则、同Gen4评价、同目标深度，并给两边相同的单次搜索时间/节点上限；只比较V8新搜索与Gen4兼容旧搜索。不是Gen5正式晋级赛。'
  };
}

function parseArgs(){
  const a=process.argv.slice(2),out={mode:'smoke',depth:2,seed:20260914,games:12};
  for(let i=0;i<a.length;i++){
    if(a[i]==='--mode')out.mode=a[++i];
    else if(a[i]==='--depth')out.depth=Math.max(1,Math.min(4,Number(a[++i])||2));
    else if(a[i]==='--seed')out.seed=(Number(a[++i])||20260914)>>>0;
    else if(a[i]==='--games')out.games=Math.max(4,Math.min(80,Number(a[++i])||12));
  }
  return out;
}
function ensureOut(){fs.mkdirSync('v8-lab-results',{recursive:true});}
function writeJson(name,x){ensureOut();fs.writeFileSync('v8-lab-results/'+name,JSON.stringify(x,null,2));}
function writeSummary(lines){ensureOut();fs.writeFileSync('v8-lab-results/summary.md',lines.join('\n'));}

const cfg=parseArgs();
console.log(`[v8-lab] ${VERSION} mode=${cfg.mode} depth=${cfg.depth} seed=${cfg.seed} baseline=Gen${LOADED_BASE.generation||'?'} `);

try{
  if(cfg.mode==='smoke'){
    const t0=Date.now();
    const ruleTests=runRuleTests();
    console.log(`[v8-lab] 规则自检通过 ${ruleTests} 项`);
    const undoChecks=runMakeUnmakeTests(cfg.seed);
    console.log(`[v8-lab] make/unmake 可逆性通过 ${undoChecks} 次`);
    const agreement=runOracleAgreement(cfg.seed,Math.min(2,cfg.depth));
    console.log(`[v8-lab] Oracle/PVS 完全一致 ${agreement.ok}/${agreement.total}`);
    const tactical=runExtensionProof(cfg.seed);
    console.log(`[v8-lab] 真战术延伸触发 ${tactical.totalExt} 次；静态战术节点 ${tactical.totalQ}`);
    const bench=runBench(cfg.seed,Math.max(2,Math.min(3,cfg.depth)));
    const result={
      version:VERSION,status:'PASS',baselineGeneration:LOADED_BASE.generation,baselineWeights:BASE_W,ruleTests,undoChecks,oracleAgreement:agreement,tactical,bench,
      elapsedMs:Date.now()-t0,
      notes:[
        'Gen4 未被修改',
        '本阶段不执行 Gen5 晋级',
        'PVS 审计时关闭静态搜索/延伸，与 Oracle 比较相同深度的精确结果',
        '正式增强搜索已单独证明真正延伸与静态战术搜索路径被调用'
      ]
    };
    writeJson('smoke.json',result);
    writeSummary([
      '# 五道方 V8 LAB A+B 自检',
      '',
      `- 状态：**PASS**`,
      `- 规则测试：${ruleTests} 项通过`,
      `- make/unmake：${undoChecks} 次可逆性检查通过`,
      `- Oracle / PVS：${agreement.ok}/${agreement.total} 个随机合法局面完全一致`,
      `- 真战术延伸：${tactical.totalExt} 次`,
      `- 静态战术搜索节点：${tactical.totalQ}`,
      `- 总耗时：${result.elapsedMs} ms`,
      '',
      '> 本轮只是验证新底盘和新搜索器正确性，不改 Gen4、不晋级 Gen5。'
    ]);
    console.log('[v8-lab] PASS');
  }else if(cfg.mode==='bench'){
    const bench=runBench(cfg.seed,cfg.depth);
    writeJson('bench.json',{version:VERSION,depth:cfg.depth,seed:cfg.seed,bench});
    console.log(JSON.stringify(bench,null,2));
  }else if(cfg.mode==='arena'){
    const arena=runArena(cfg.seed,cfg.depth,cfg.games);
    writeJson('arena.json',arena);
    writeSummary([
      '# 五道方 V8-C 纯搜索器实验擂台','',
      `- V8版本：${VERSION}`,
      `- 对局：${arena.games}盘（${arena.pairs}个场景，每个场景成对换边）`,
      `- 深度目标：${arena.depth}；单次搜索时间上限：${arena.timeBudgetMs}ms；每次迭代节点上限：${arena.nodeBudget}`,
      `- V8：${arena.v8Wins}胜；Gen4兼容旧搜索：${arena.legacyWins}胜；和棋：${arena.draws}`,
      `- **V8得分率：${(arena.v8Score*100).toFixed(1)}%**`,
      `- V8执黑：${arena.v8Black.w}胜/${arena.v8Black.l}负/${arena.v8Black.d}和`,
      `- V8执白：${arena.v8White.w}胜/${arena.v8White.l}负/${arena.v8White.d}和`,
      `- V8真实战术延伸：${arena.v8Extensions}次；静态战术节点：${arena.v8QNodes}`,
      `- 节点：V8 ${arena.totalNodes.v8} / 旧搜索 ${arena.totalNodes.legacy}`,
      `- safety-cap：${arena.safetyCaps}`,
      `- 耗时：${(arena.elapsedMs/1000).toFixed(1)}秒`,'',
      '> 这不是Gen5晋级赛。双方使用同一Gen4评价与同一规则，并使用相同搜索时间/节点上限；本实验不会修改正式基线。'
    ]);
    console.log(`[v8-lab] ARENA DONE：V8 ${arena.v8Wins}胜 / 旧搜索 ${arena.legacyWins}胜 / ${arena.draws}和；得分率 ${(arena.v8Score*100).toFixed(1)}%`);
  }else{
    throw new Error('未知 mode：'+cfg.mode);
  }
}catch(err){
  ensureOut();
  writeJson('failure.json',{version:VERSION,status:'FAIL',message:err.message,stack:err.stack});
  writeSummary(['# 五道方 V8 LAB A+B 自检','','- 状态：**FAIL**',`- 原因：${err.message}`]);
  console.error('[v8-lab] FAIL',err);
  process.exit(1);
}
