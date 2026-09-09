#!/usr/bin/env node
'use strict';

/*
  五道方 V8-D · 深度教师数据采集器
  ------------------------------------------------------------
  目标：
  1) 不修改 Gen4 baseline，不做任何晋级。
  2) 复用 trainer/v8_lab.mjs 当前 V8-C3 规则/搜索核心。
  3) 用 V8 与冻结原生 Gen4 的“意见分歧 + 小优势差 + 战术/残局稀有度”
     挖掘高价值局面（Hard Position Mining）。
  4) 再用更深 V8 搜索生成 value + top-k policy 教师标签。
  5) 输出 JSONL 数据集、manifest、摘要，供下一阶段 NNUE-Lite 训练。
*/

import fs from 'node:fs';
import vm from 'node:vm';

const VERSION = 'v8-teacher-d1-hardmine-0.1';

function loadLabCore(){
  const path='trainer/v8_lab.mjs';
  if(!fs.existsSync(path))throw new Error('找不到 '+path);
  let src=fs.readFileSync(path,'utf8');
  const m=src.match(/const VERSION='([^']+)'/);
  const labVersion=m?.[1]||'unknown';
  if(!labVersion.includes('v8-lab-c3')) {
    throw new Error('教师采集器要求 V8-C3，当前是 '+labVersion);
  }
  src=src.replace(/import fs from 'node:fs';\s*/,'');
  const cut=src.indexOf('\nconst cfg=parseArgs();');
  if(cut<0)throw new Error('无法定位 v8_lab.mjs CLI 边界');
  src=src.slice(0,cut);
  src += `
globalThis.__V8_API={
  VERSION,PHASE,PHASE_NAME,LOADED_BASE,BASE_W,
  actions,actionCode,actionText,hashState,canonicalState,
  randomPlayout,searchV8,evalBlack,cloneStateFast,
  toNativeState,nativeSearchRoot,nativeToV8Action,
  runBridgeCheck,rawPatterns,protectedMask,legalMoveCount,
  popcnt32,playerMask
};`;
  const box={
    fs,console,Date,Math,JSON,Set,Map,Uint8Array,Int32Array,Array,Object,
    Number,String,Boolean,BigInt,Infinity,NaN,parseInt,parseFloat,process,Buffer
  };
  vm.createContext(box);
  vm.runInContext(src,box,{filename:'v8_lab.core.js',timeout:20_000});
  if(!box.__V8_API)throw new Error('V8核心暴露失败');
  return box.__V8_API;
}

function parseArgs(){
  const a=process.argv.slice(2);
  const out={mode:'check',samples:8,depth:3,seed:20260921};
  for(let i=0;i<a.length;i++){
    if(a[i]==='--mode')out.mode=a[++i];
    else if(a[i]==='--samples')out.samples=Math.max(4,Math.min(80,Number(a[++i])||8));
    else if(a[i]==='--depth')out.depth=Math.max(2,Math.min(4,Number(a[++i])||3));
    else if(a[i]==='--seed')out.seed=(Number(a[++i])||20260921)>>>0;
  }
  return out;
}
function ensureOut(){fs.mkdirSync('v8-teacher-results',{recursive:true});}
function writeJson(name,x){ensureOut();fs.writeFileSync('v8-teacher-results/'+name,JSON.stringify(x,null,2));}
function writeText(name,s){ensureOut();fs.writeFileSync('v8-teacher-results/'+name,s);}
function clamp(x,a,b){return Math.max(a,Math.min(b,x));}
function softmaxLoss(entries,temp=180){
  if(!entries.length)return[];
  const best=entries[0].score;
  const ws=entries.map(e=>Math.exp(-clamp(best-e.score,0,5000)/temp));
  const z=ws.reduce((a,b)=>a+b,0)||1;
  return entries.map((e,i)=>({
    code:e.code,action:e.action,score:e.score,
    loss:Number((best-e.score).toFixed(4)),
    p:Number((ws[i]/z).toFixed(6))
  }));
}
function splitFromHash(h){
  const n=parseInt(h.slice(-4),16)%100;
  return n<80?'train':n<90?'val':'test';
}
function countRep(rep){let max=0;for(const v of rep.values())max=Math.max(max,v);return max;}

function serializeState(api,s,noProgress,rep){
  const p1=api.popcnt32(api.playerMask(s,1)),p2=api.popcnt32(api.playerMask(s,2));
  return{
    blackMask:s.blackMask>>>0,whiteMask:s.whiteMask>>>0,
    owner:[...s.owner],pid:[...s.pid],
    nextId1:s.nextId1,nextId2:s.nextId2,
    claimed1:[...s.claimed1].sort((a,b)=>a-b),
    claimed2:[...s.claimed2].sort((a,b)=>a-b),
    phase:s.phase,phaseName:api.PHASE_NAME[s.phase],turn:s.turn,
    bonusLeft:s.bonusLeft,captureLeft:s.captureLeft,openingStage:s.openingStage,
    noProgress,repMax:countRep(rep),
    pieceCount:{black:p1,white:p2},
    protectedCount:{
      black:api.popcnt32(api.protectedMask(s,1)),
      white:api.popcnt32(api.protectedMask(s,2))
    },
    patternScore:{
      black:api.rawPatterns(s,1).reduce((z,p)=>z+p.score,0),
      white:api.rawPatterns(s,2).reduce((z,p)=>z+p.score,0)
    }
  };
}

function shallowProbe(api,p){
  const s=p.s,root=s.turn;
  const v8=api.searchV8(s,2,root,{
    rep:p.rep,noProgress:p.noProgress,useQ:true,extensions:1,qDepth:1,
    nodeLimit:45_000,maxMs:90
  });
  const nat=api.nativeSearchRoot(api.toNativeState(s),2,root,'teacher-screen-gen4');
  const natA=api.nativeToV8Action(nat.action);
  const nativeCode=natA?api.actionCode(natA):-1;
  const legal=api.actions(s).length;
  const ranked=(v8.ranked||[]).map(e=>({score:Number(e.score),code:e.code}));
  const margin=ranked.length>1?Math.abs(ranked[0].score-ranked[1].score):9999;
  const disagree=v8.bestCode!==nativeCode;
  const evalB=api.evalBlack(s);
  const uncertain=4/(1+Math.abs(evalB)/350);
  const close=5/(1+margin/120);
  const phase=api.PHASE_NAME[s.phase];
  const tactical=(phase==='capture'?2.5:phase==='opening'?2.0:0)+(legal<=5?2:legal<=8?1:0);
  const history=p.noProgress>=20?1:0;
  const completion=(v8.depth>=2?0.5:-1)+(nat.depth>=2?0.5:-1);
  const hardness=(disagree?8:0)+uncertain+close+tactical+history+completion;
  return{
    hardness:Number(hardness.toFixed(4)),disagree,margin:Number(margin.toFixed(4)),
    evalBlack:Number(evalB.toFixed(4)),legal,phase,
    v8:{bestCode:v8.bestCode,best:api.actionText(v8.action),score:Number(v8.score.toFixed(4)),depth:v8.depth,nodes:v8.nodes},
    gen4:{bestCode:nativeCode,best:natA?api.actionText(natA):'',score:Number(nat.score.toFixed(4)),depth:nat.depth,nodes:nat.nodes,budgetCut:!!nat.budgetCut}
  };
}

function mineCandidates(api,seed,samples,mode){
  const wanted=Math.max(mode==='check'?18:samples*6,24);
  const maxAttempts=wanted*8;
  const seen=new Set(),pool=[];
  for(let i=0;i<maxAttempts&&pool.length<wanted;i++){
    const plies=8+((i*13 + (seed%17))%66);
    const p=api.randomPlayout((seed+Math.imul(i+1,2654435761))>>>0,plies);
    const s=p.s;
    if(s.winner)continue;
    const legal=api.actions(s).length;
    if(legal<2)continue;
    const hash=api.hashState(s);
    if(seen.has(hash))continue;
    seen.add(hash);
    const probe=shallowProbe(api,p);
    pool.push({hash,plies,p,probe});
    if((pool.length%10)===0)console.log(`[teacher] 预筛 ${pool.length}/${wanted}`);
  }
  if(pool.length<Math.min(samples,8))throw new Error('可用候选局面不足：'+pool.length);
  pool.sort((a,b)=>b.probe.hardness-a.probe.hardness);

  // 先按阶段取样，再按综合难度补齐，避免数据几乎全挤在一种阶段。
  const picked=[],used=new Set();
  const phases=['place','opening','move','capture'];
  const quota=Math.max(1,Math.floor(samples/4));
  for(const ph of phases){
    for(const x of pool){
      if(picked.filter(y=>y.probe.phase===ph).length>=quota)break;
      if(x.probe.phase===ph&&!used.has(x.hash)){picked.push(x);used.add(x.hash);}
    }
  }
  for(const x of pool){
    if(picked.length>=samples)break;
    if(!used.has(x.hash)){picked.push(x);used.add(x.hash);}
  }
  return{pool,picked:picked.slice(0,samples)};
}

function deepLabel(api,item,depth,mode){
  const {p,hash,plies,probe}=item,s=p.s,root=s.turn;
  let nodeLimit,maxMs,qDepth;
  if(mode==='check'){
    nodeLimit=140_000;maxMs=320;qDepth=1;depth=Math.min(depth,2);
  }else if(depth<=3){
    nodeLimit=500_000;maxMs=900;qDepth=2;
  }else{
    nodeLimit=1_800_000;maxMs=2800;qDepth=2;
  }
  const t0=Date.now();
  const deep=api.searchV8(s,depth,root,{
    rep:p.rep,noProgress:p.noProgress,useQ:true,extensions:1,qDepth,nodeLimit,maxMs
  });
  if(!deep.action)throw new Error('教师搜索无合法动作 hash='+hash);
  const ranked=(deep.ranked||[]).slice(0,8).map(e=>({
    code:e.code,action:api.actionText(e.a),score:Number(e.score.toFixed(4))
  }));
  if(!ranked.length)ranked.push({
    code:deep.bestCode,action:api.actionText(deep.action),score:Number(deep.score.toFixed(4))
  });
  ranked.sort((a,b)=>b.score-a.score);
  const topPolicy=softmaxLoss(ranked.slice(0,5));
  const valueMover=Number(deep.score.toFixed(4));
  const valueBlack=root===1?valueMover:-valueMover;
  return{
    schema:'wudafang-v8-teacher-v1',
    engine:{teacher:api.VERSION,collector:VERSION,baselineGeneration:api.LOADED_BASE.generation},
    source:{
      seed:null,hash,plies,phase:api.PHASE_NAME[s.phase],turn:root,
      miningScore:probe.hardness,reasons:{
        disagreement:probe.disagree,shallowMargin:probe.margin,
        uncertainEvalBlack:probe.evalBlack,legal:probe.legal
      },
      shallow:{v8:probe.v8,gen4:probe.gen4}
    },
    state:serializeState(api,s,p.noProgress,p.rep),
    target:{
      requestedDepth:depth,completedDepth:deep.depth,aborted:!!deep.aborted,
      bestCode:deep.bestCode,bestAction:api.actionText(deep.action),
      valueMover,valueBlack:Number(valueBlack.toFixed(4)),
      valueNorm:Number(Math.tanh(valueMover/900).toFixed(6)),
      policyTop:topPolicy
    },
    search:{
      nodes:deep.nodes,qnodes:deep.qnodes,extensions:deep.extensions,drawLeaves:deep.drawLeaves,
      elapsedMs:Date.now()-t0,nodeLimit,maxMs
    },
    split:splitFromHash(hash),
    symmetry:0
  };
}

function run(api,cfg){
  const t0=Date.now();
  const bridge=api.runBridgeCheck((cfg.seed^0xD15EA5E)>>>0);
  console.log(`[teacher] core=${api.VERSION} bridge=${bridge.status}`);
  const mined=mineCandidates(api,cfg.seed,cfg.samples,cfg.mode);
  console.log(`[teacher] 候选 ${mined.pool.length}，选中 ${mined.picked.length}`);
  const rows=[];
  for(let i=0;i<mined.picked.length;i++){
    const row=deepLabel(api,mined.picked[i],cfg.depth,cfg.mode);
    row.source.seed=cfg.seed;
    rows.push(row);
    console.log(`[teacher] 深标 ${i+1}/${mined.picked.length} ${row.source.phase} `+
      `hard=${row.source.miningScore} depth=${row.target.completedDepth}/${row.target.requestedDepth} `+
      `best=${row.target.bestAction}`);
  }
  const split={train:0,val:0,test:0};
  const phase={};
  let disagreement=0,completed=0,totalNodes=0;
  for(const r of rows){
    split[r.split]++;phase[r.source.phase]=(phase[r.source.phase]||0)+1;
    if(r.source.reasons.disagreement)disagreement++;
    if(r.target.completedDepth>=r.target.requestedDepth)completed++;
    totalNodes+=r.search.nodes;
  }
  const manifest={
    version:VERSION,status:'PASS',mode:cfg.mode,seed:cfg.seed,
    requestedSamples:cfg.samples,actualSamples:rows.length,teacherDepth:cfg.mode==='check'?Math.min(cfg.depth,2):cfg.depth,
    engineVersion:api.VERSION,baselineGeneration:api.LOADED_BASE.generation,
    bridge:{status:bridge.status,samples:bridge.samples,applyChecks:bridge.applyChecks},
    mining:{candidatePool:mined.pool.length,disagreementSelected:disagreement,phase},
    split,deepCompleted:completed,totalNodes,elapsedMs:Date.now()-t0,
    notes:[
      '不修改 data/ai-baseline.json',
      '训练数据按局面 hash 固定划分 train/val/test',
      '当前 symmetry=0，几何对称增强将在训练阶段单独做，避免采集器先引入变换错误',
      'policyTop 由深搜 top-k 分数差转换为软标签；valueNorm=tanh(valueMover/900)'
    ]
  };
  ensureOut();
  writeText('dataset.jsonl',rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
  writeJson('manifest.json',manifest);
  writeJson('selected-preview.json',rows.slice(0,Math.min(8,rows.length)));
  writeText('summary.md',[
    '# 五道方 V8-D 教师数据采集','',
    `- 状态：**PASS**`,
    `- 采集器：${VERSION}`,
    `- 教师引擎：${api.VERSION}`,
    `- Gen4基线：Gen${api.LOADED_BASE.generation}（未修改）`,
    `- 桥接自检：${bridge.status}（${bridge.samples}状态 / ${bridge.applyChecks}次apply）`,
    `- 预筛候选：${mined.pool.length}`,
    `- 最终深标：${rows.length}`,
    `- V8/Gen4意见分歧样本：${disagreement}/${rows.length}`,
    `- 深搜完整完成：${completed}/${rows.length}`,
    `- 阶段分布：${JSON.stringify(phase)}`,
    `- 数据划分：train ${split.train} / val ${split.val} / test ${split.test}`,
    `- 教师总节点：${totalNodes}`,
    `- 总耗时：${((Date.now()-t0)/1000).toFixed(1)}秒`,'',
    '> 这是训练数据管线验证/采集，不是Gen5晋级，不会写入正式baseline。'
  ].join('\n'));
  return manifest;
}

const cfg=parseArgs();
if(!['check','collect'].includes(cfg.mode)){
  console.error('[teacher] FAIL 未知 mode='+cfg.mode);
  process.exit(1);
}
console.log(`[teacher] ${VERSION} mode=${cfg.mode} samples=${cfg.samples} depth=${cfg.depth} seed=${cfg.seed}`);
try{
  const api=loadLabCore();
  const manifest=run(api,cfg);
  console.log(`[teacher] DONE samples=${manifest.actualSamples} deepComplete=${manifest.deepCompleted}/${manifest.actualSamples}`);
}catch(err){
  ensureOut();
  writeJson('failure.json',{version:VERSION,status:'FAIL',message:err.message,stack:err.stack});
  writeText('summary.md','# 五道方 V8-D 教师数据采集\n\n- 状态：**FAIL**\n- 原因：'+err.message+'\n');
  console.error('[teacher] FAIL',err);
  process.exit(1);
}
