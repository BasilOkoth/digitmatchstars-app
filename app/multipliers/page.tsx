'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDerivWSContext } from '@/components/custom/deriv-ws-provider';

type Position = {contract_id?:number;is_sold?:boolean|number;profit?:number|string;status?:string;buy_price?:number|string;sell_price?:number|string};
type RecordTrade = {id:number;direction:'UP'|'DOWN';stake:number;multiplier:number;entryMomentum:number;entryVol:number;profit:number;status:string};
const N=(s:string)=>Number(s);
const money=(n:number)=>`${n>0?'+':n<0?'−':''}$${Math.abs(n).toFixed(2)}`;
export default function MultipliersPage(){
 const {ws,isConnected,auth}=useDerivWSContext();
 const account=auth.activeAccount;
 const connected=!!ws&&isConnected&&!!auth.wsUrl&&!!account;
 const [symbol,setSymbol]=useState('1HZ100V');
 const [stake,setStake]=useState('1');
 const [multiplier,setMultiplier]=useState('20');
 const [tp,setTp]=useState('1');
 const [sl,setSl]=useState('1');
 const [maxTrades,setMaxTrades]=useState('3');
 const [maxLoss,setMaxLoss]=useState('3');
 const [lookback,setLookback]=useState('20');
 const [minMomentum,setMinMomentum]=useState('0.03');
 const [maxVol,setMaxVol]=useState('0.15');
 const [cooldown,setCooldown]=useState('5');
 const [liveConfirm,setLiveConfirm]=useState(false);
 const [running,setRunning]=useState(false);
 const [pending,setPending]=useState(false);
 const [openId,setOpenId]=useState<number|null>(null);
 const [count,setCount]=useState(0);
 const [pnl,setPnl]=useState(0);
 const [quote,setQuote]=useState<number|null>(null);
 const [signal,setSignal]=useState({direction:'WAIT',momentum:0,vol:0,ready:false,reason:'Collecting ticks'});
 const [records,setRecords]=useState<RecordTrade[]>([]);
 const [events,setEvents]=useState<string[]>([]);
 const [error,setError]=useState('');
 const prices=useRef<number[]>([]);
 const tickNo=useRef(0);
 const lastEntry=useRef(-10000);
 const runningRef=useRef(false);
 const busyRef=useRef(false);
 const openRef=useRef<number|null>(null);
 const countRef=useRef(0);
 const pnlRef=useRef(0);
 const session=useRef(0);
 const entry=useRef<Omit<RecordTrade,'profit'|'status'>|null>(null);
 const signalRef=useRef(signal);
 const accountRef=useRef(account?.account_id??'');
 const lastAttempt=useRef(-1);
 const log=useCallback((s:string)=>setEvents(v=>[`${new Date().toLocaleTimeString()}  ${s}`,...v].slice(0,100)),[]);
 const stop=useCallback((reason='Stopped; any open contract remains active.')=>{runningRef.current=false;setRunning(false);session.current++;log(reason);},[log]);
 const settle=useCallback((c:Position)=>{
   const id=Number(c.contract_id);
   if(!id||id!==openRef.current||!c.is_sold)return;
   openRef.current=null;setOpenId(null);
   const profit=Number(c.profit);
   if(!Number.isFinite(profit)){stop('Missing settlement profit; check Deriv positions.');return;}
   pnlRef.current+=profit;setPnl(pnlRef.current);
   if(entry.current?.id===id){setRecords(v=>[{...entry.current!,profit,status:c.status??'closed'},...v].slice(0,100));entry.current=null;}
   else stop('Unmatched settlement; trading halted.');
   log(`${profit>0?'WIN':profit<0?'LOSS':'FLAT'} #${id}: ${money(profit)} (${c.status??'closed'})`);
   if(countRef.current>=N(maxTrades)||pnlRef.current<=-N(maxLoss))stop('Trade or loss limit reached.');
 },[log,maxTrades,maxLoss,stop]);
 useEffect(()=>{prices.current=[];signalRef.current={direction:'WAIT',momentum:0,vol:0,ready:false,reason:'Collecting ticks'};setSignal(signalRef.current);},[symbol]);
 useEffect(()=>{
  if(!ws||!isConnected||!auth.wsUrl)return;
  const off=ws.onMessage(frame=>{
   if(frame.msg_type==='proposal_open_contract')settle(frame.proposal_open_contract as Position);
   if(frame.msg_type!=='tick')return;
   const t=frame.tick as {symbol?:string;quote?:number}|undefined;
   if(!t||t.symbol!==symbol||!Number.isFinite(Number(t.quote)))return;
   const q=Number(t.quote);setQuote(q);tickNo.current++;
   prices.current=[...prices.current.slice(-199),q];
   const window=N(lookback);
   const p=prices.current;
   if(!Number.isSafeInteger(window)||window<5||p.length<window+1){const s={direction:'WAIT',momentum:0,vol:0,ready:false,reason:`Warm-up ${p.length}/${window+1} ticks`};signalRef.current=s;setSignal(s);return;}
   const recent=p.slice(-window-1);
   const returns=recent.slice(1).map((v,i)=>(v-recent[i])/recent[i]*100);
   const mean=returns.reduce((a,b)=>a+b,0)/returns.length;
   const vol=Math.sqrt(returns.reduce((a,b)=>a+(b-mean)**2,0)/returns.length);
   const momentum=(recent.at(-1)!/recent[0]-1)*100;
   const direction=momentum>=N(minMomentum)?'UP':momentum<=-N(minMomentum)?'DOWN':'WAIT';
   const cooled=tickNo.current-lastEntry.current>=N(cooldown);
   const ready=direction!=='WAIT'&&vol<=N(maxVol)&&cooled;
   const reason=vol>N(maxVol)?'Volatility too high':direction==='WAIT'?'Momentum below threshold':!cooled?'Cooldown active':'Signal eligible';
   const s={direction,momentum,vol,ready,reason};signalRef.current=s;setSignal(s);
  });
  let disposed=false;let unsubscribe:(()=>Promise<void>)|undefined;
  void ws.subscribe({ticks:symbol},()=>{}).then(sub=>{if(disposed)void sub.unsubscribe();else unsubscribe=sub.unsubscribe;}).catch(e=>setError(String(e)));
  return()=>{disposed=true;off();if(unsubscribe)void unsubscribe();};
 },[ws,isConnected,auth.wsUrl,symbol,lookback,minMomentum,maxVol,cooldown,settle]);
 useEffect(()=>{
  if(!ws||!isConnected||openId===null)return;
  let disposed=false;let unsubscribe:(()=>Promise<void>)|undefined;
  void ws.subscribe({proposal_open_contract:1,contract_id:openId},frame=>settle(frame.proposal_open_contract as Position)).then(sub=>{if(disposed)void sub.unsubscribe();else unsubscribe=sub.unsubscribe;}).catch(e=>{setError(`Contract monitoring failed: ${String(e)}`);stop('Monitoring unavailable; check open positions.');});
  return()=>{disposed=true;if(unsubscribe)void unsubscribe();};
 },[ws,isConnected,openId,settle,stop]);
 useEffect(()=>{if(accountRef.current!==(account?.account_id??'')){accountRef.current=account?.account_id??'';if(runningRef.current)stop('Account changed.');}},[account?.account_id,stop]);
 useEffect(()=>{if(!isConnected&&runningRef.current)stop('Connection lost. Check open contracts.');},[isConnected,stop]);
 const buy=useCallback(async()=>{
  if(!ws||!runningRef.current||busyRef.current||openRef.current!==null||!signalRef.current.ready)return;
  if(countRef.current>=N(maxTrades)||pnlRef.current-N(stake)<-N(maxLoss)){stop('Trade/loss limit reached.');return;}
  busyRef.current=true;setPending(true);const epoch=session.current;
  const s=signalRef.current;const direction=s.direction as 'UP'|'DOWN';
  const startTick=tickNo.current;
  try{
   const proposalResponse=await ws.send<{proposal?:{id?:string;ask_price?:number|string}}>({proposal:1,amount:N(stake),basis:'stake',contract_type:direction==='UP'?'MULTUP':'MULTDOWN',currency:'USD',underlying_symbol:symbol,multiplier:N(multiplier),limit_order:{take_profit:N(tp),stop_loss:N(sl)}});
   const proposal=proposalResponse.proposal;
   if(!proposal?.id||!Number.isFinite(Number(proposal.ask_price)))throw Error('No valid multiplier proposal returned by Deriv');
   if(epoch!==session.current||!runningRef.current)return;
   const fresh=signalRef.current;
   if(!fresh.ready||fresh.direction!==direction||tickNo.current-startTick>2){log('Signal changed while proposal was pending; purchase skipped.');return;}
   const price=Number(proposal.ask_price);
   if(price>N(stake)*1.02)throw Error('Proposal price exceeds stake tolerance');
   lastEntry.current=tickNo.current;
   log(`BUY ${direction}: ${symbol}, stake $${N(stake).toFixed(2)}, ×${multiplier}, momentum ${s.momentum.toFixed(4)}%, volatility ${s.vol.toFixed(4)}%.`);
   // Never retry an ambiguous purchase response; the order may have succeeded.
   const result=await ws.send<{buy?:{contract_id?:number}}>({buy:proposal.id,price});
   const id=Number(result.buy?.contract_id);
   if(!Number.isSafeInteger(id)||id<=0)throw Error('Buy response missing contract ID. Verify open positions before restarting.');
   openRef.current=id;setOpenId(id);countRef.current++;setCount(countRef.current);
   entry.current={id,direction,stake:N(stake),multiplier:N(multiplier),entryMomentum:s.momentum,entryVol:s.vol};
   log(`Contract #${id} opened; monitoring settlement.`);
  }catch(e){setError(String(e));stop('Order failed or status uncertain; verify Deriv positions.');}
  finally{busyRef.current=false;setPending(false);}
 },[ws,stake,maxLoss,maxTrades,symbol,multiplier,tp,sl,log,stop]);
 useEffect(()=>{
  if(!running||!connected||pending||openId!==null||count>=N(maxTrades)||!signal.ready)return;
  if(lastAttempt.current===tickNo.current)return;
  lastAttempt.current=tickNo.current;
  void buy();
 },[running,connected,pending,openId,count,maxTrades,signal,buy]);
 function start(){
  setError('');
  if(!connected){setError('Sign in to Deriv through Digit Match first.');return;}
  if(openRef.current!==null||busyRef.current){setError('An order or contract is still pending.');return;}
  if(![stake,multiplier,tp,sl,maxTrades,maxLoss,minMomentum,maxVol,lookback,cooldown].every(v=>Number.isFinite(N(v)))||N(stake)<=0||N(multiplier)<=0||N(tp)<=0||N(sl)<=0||N(maxLoss)<N(stake)||N(maxTrades)<1||!Number.isInteger(N(maxTrades))||N(lookback)<5||N(lookback)>199||N(maxVol)<=0||N(minMomentum)<=0||N(cooldown)<0){setError('Invalid trade settings. Maximum loss must cover at least one full stake.');return;}
  if(account?.account_type!=='demo'&&!liveConfirm){setError('Confirm real-money trading before starting.');return;}
  countRef.current=0;pnlRef.current=0;setCount(0);setPnl(0);
  session.current++;runningRef.current=true;setRunning(true);lastAttempt.current=-1;
  log(`Started ${account?.account_type??'unknown'} multipliers on ${account?.account_id}.`);
 }
 const card='rounded-xl border border-white/10 bg-[#10192a] p-3';
 const field='mt-1 w-full rounded-lg border border-white/10 bg-[#111c31] px-2.5 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400';
 const label='text-xs font-bold uppercase tracking-wider text-slate-400';
 return <main className="min-h-screen bg-[#080e1b] px-3 py-4 text-slate-100"><div className="mx-auto max-w-6xl space-y-3">
  <header className="flex flex-wrap items-center justify-between gap-3"><div><div className="text-xs font-bold uppercase tracking-[.2em] text-cyan-300">DigitMatchStars / Trading Suite</div><h1 className="text-2xl font-black">Multipliers <span className="text-cyan-300">PRO</span></h1></div><div className="flex gap-2"><Link href="/" className="rounded-lg border border-white/20 px-3 py-2 text-sm">← Digit Match</Link><Link href="/accumulator" className="rounded-lg border border-white/20 px-3 py-2 text-sm">Accumulator</Link></div></header>
  <div className="grid grid-cols-2 gap-2 md:grid-cols-4">{[['ENGINE',running?'RUNNING':'STOPPED'],['ACCOUNT',account?.account_id??'LOGIN REQUIRED'],['OPEN CONTRACT',openId??'—']].map(([a,b])=><div key={String(a)} className={card}><div className="text-xs text-slate-400">{a}</div><div className="mt-1 text-base font-black text-cyan-300">{b}</div></div>)}<div className={card}><div className="text-xs text-slate-400">SESSION P/L</div><div className={`mt-1 text-xl font-black ${pnl>0?'text-green-400':pnl<0?'text-red-400':'text-white'}`}>{money(pnl)}</div></div></div>
  <div className="grid gap-3 lg:grid-cols-2"><section className={card}><h2 className="mb-2 font-bold">01 / Trade configuration</h2><p className="mb-2 text-xs text-slate-400">{connected?`● Connected to ${account?.account_type} ${account?.account_id}`:'○ Log in through Digit Match first'}</p><div className="grid grid-cols-2 gap-2">
  {([['Symbol',symbol,setSymbol],['Stake (USD)',stake,setStake],['Multiplier',multiplier,setMultiplier],['Take-profit (USD)',tp,setTp],['Stop-loss (USD)',sl,setSl],['Max trades',maxTrades,setMaxTrades],['Max loss (USD)',maxLoss,setMaxLoss],['Momentum window (ticks)',lookback,setLookback],['Min momentum %',minMomentum,setMinMomentum],['Max volatility %',maxVol,setMaxVol],['Cooldown ticks',cooldown,setCooldown]] as const).map(([name,value,update])=><label key={name} className={label}>{name}<input className={field} value={value} onChange={e=>update(e.target.value)} disabled={running||pending} type={name==='Symbol'?'text':'number'} step="any"/></label>)}
  </div><div className="mt-3 rounded-lg bg-[#080e1b] p-2 text-xs"><span className={`font-black ${signal.ready?'text-green-400':'text-amber-300'}`}>{signal.direction}</span> · Momentum {signal.momentum.toFixed(4)}% · Vol {signal.vol.toFixed(4)}% · {signal.reason}</div>
  {account?.account_type!=='demo'&&<label className="mt-3 flex gap-2 text-xs text-amber-200"><input type="checkbox" checked={liveConfirm} onChange={e=>setLiveConfirm(e.target.checked)}/>I authorize real-money multiplier orders.</label>}
  <button className={`mt-3 w-full rounded-lg px-4 py-2.5 font-black ${running?'bg-rose-500/20 text-rose-300':'bg-emerald-400 text-slate-950'} disabled:opacity-40`} disabled={!running&&(!connected||pending||openId!==null)} onClick={()=>running?stop():start()}>{running?'■ STOP TRADING':`▶ START ${account?.account_type?.toUpperCase()??'TRADING'}`}</button>
  {error&&<div role="alert" className="mt-2 text-sm font-bold text-red-400">{error}</div>}</section>
  <section className={card}><h2 className="mb-2 font-bold">02 / Live execution</h2>{[['Connection',connected?'CONNECTED':'DISCONNECTED'],['Market',symbol],['Last quote',quote??'Waiting'],['Trades',`${count} / ${maxTrades}`],['Order',pending?'REQUEST IN FLIGHT':openId?'OPEN CONTRACT':running?'READY':'IDLE']].map(([a,b])=><div key={String(a)} className="mb-1 flex justify-between rounded-lg bg-[#080e1b] p-2 text-sm"><span className="text-slate-400">{a}</span><strong>{b}</strong></div>)}<p className="mt-3 text-xs leading-5 text-amber-200">Stop blocks new orders; it does not close an existing multiplier. Verify positions in Deriv after disconnects. Momentum signals are experimental and do not establish profitability.</p></section></div>
  <section className={card}><h2 className="mb-2 font-bold">03 / Contract audit · <span className="text-green-400">{records.filter(r=>r.profit>0).length} WINS</span> · <span className="text-red-400">{records.filter(r=>r.profit<0).length} LOSSES</span></h2><div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-xs"><thead><tr>{['Contract','Direction','Multiplier','Entry momentum','Volatility','Profit','Status'].map(h=><th key={h} className="p-2 text-slate-400">{h}</th>)}</tr></thead><tbody>{records.map(r=><tr key={r.id} className="border-t border-white/10"><td className="p-2">{r.id}</td><td className="p-2 font-bold">{r.direction}</td><td className="p-2">×{r.multiplier}</td><td className="p-2">{r.entryMomentum.toFixed(4)}%</td><td className="p-2">{r.entryVol.toFixed(4)}%</td><td className={`p-2 font-black ${r.profit>0?'text-green-400':r.profit<0?'text-red-400':''}`}>{money(r.profit)}</td><td className={`p-2 font-black ${r.profit>0?'text-green-400':r.profit<0?'text-red-400':''}`}>{r.status}</td></tr>)}</tbody></table>{records.length===0&&<p className="p-2 text-sm text-slate-400">No settled trades yet.</p>}</div></section>
  <section className={card}><h2 className="mb-2 font-bold">04 / Execution events</h2><div className="max-h-64 overflow-auto space-y-1 font-mono text-xs">{events.length?events.map((e,i)=><div key={i} className={`rounded-lg bg-[#080e1b] p-2 ${e.includes('WIN #')?'font-black text-green-400':e.includes('LOSS #')?'font-black text-red-400':''}`}>{e}</div>):'No events yet.'}</div></section>
 </div></main>;
}
