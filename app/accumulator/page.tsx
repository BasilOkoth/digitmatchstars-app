'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDerivWSContext } from '@/components/custom/deriv-ws-provider';

type Event = { time: string; message: string };
type Contract = { contract_id?: number; is_sold?: number | boolean; profit?: number | string; status?: string; bid_price?: number | string; buy_price?: number | string; sell_price?: number | string; payout?: number | string; current_spot?: number; limit_order?: {take_profit?: number | string}; transaction_ids?: {buy?: number; sell?: number} };
type Audit = {contractId:number; account:string; symbol:string; stake:number; growth:number; requestedTakeProfit:number; proposalAsk:number; proposalPayout?:number; buyPrice?:number; settledProfit?:number; sellPrice?:number; status?:string; acceptedTakeProfit?:number; verified:boolean};
const num = (v: string) => Number(v);
export default function AccumulatorPage() {
  const {ws,isConnected,auth} = useDerivWSContext();
  const account = auth.activeAccount;
  const authorized = !!auth.wsUrl && !!account && isConnected && !!ws;
  const [symbol,setSymbol] = useState('1HZ100V');
  const [stake,setStake] = useState('1');
  const [growth,setGrowth] = useState('0.02');
  const [takeProfit,setTakeProfit] = useState('0.20');
  const [maxTrades,setMaxTrades] = useState('3');
  const [maxLoss,setMaxLoss] = useState('3');
  const [momentumEnabled,setMomentumEnabled] = useState(true);
  const [minTicks,setMinTicks] = useState('40');
  const [maxVolatility,setMaxVolatility] = useState('0.12');
  const [minEfficiency,setMinEfficiency] = useState('0.20');
  const [cooldownTicks,setCooldownTicks] = useState('5');
  const [marketStats,setMarketStats] = useState({samples:0,volatility:0,efficiency:0,ready:false,reason:'Collecting market ticks'});
  const pricesRef=useRef<number[]>([]);
  const lastEntryTickRef=useRef(-100000);
  const lastEvaluatedTickRef=useRef(-1);
  const [confirmLive,setConfirmLive] = useState(false);
  const [running,setRunning] = useState(false);
  const [pending,setPending] = useState(false);
  const [openId,setOpenId] = useState<number|null>(null);
  const [trades,setTrades] = useState(0);
  const [pnl,setPnl] = useState(0);
  const [tick,setTick] = useState<number|null>(null);
  const [events,setEvents] = useState<Event[]>([]);
  const [error,setError] = useState('');
  const [audit,setAudit] = useState<Audit[]>([]);
  const auditRef=useRef<Audit|null>(null);
  const [lifetimePnl,setLifetimePnl] = useState(0);
  const lifetimeRef=useRef(0);
  const runningRef=useRef(false);
  const busyRef=useRef(false);
  const openRef=useRef<number|null>(null);
  const tradesRef=useRef(0);
  const pnlRef=useRef(0);
  const tickCount=useRef(0);
  const session=useRef(0);
  const accountRef=useRef(account?.account_id ?? '');
  const log=useCallback((message:string)=>setEvents(v=>[...v.slice(-99),{time:new Date().toLocaleTimeString(),message}]),[]);
  const stop=useCallback((reason='Stopped. Existing contracts remain open.')=>{runningRef.current=false;setRunning(false);session.current++;log(reason);},[log]);
  const settle=useCallback((c:Contract)=>{
    const id=Number(c.contract_id);
    if(!id || id!==openRef.current || !c.is_sold) return;
    openRef.current=null;setOpenId(null);
    const profit=Number(c.profit);
    if(!Number.isFinite(profit)){stop('Settlement amount unavailable. Trading halted.');return;}
    pnlRef.current+=profit;setPnl(pnlRef.current);
    lifetimeRef.current+=profit;setLifetimePnl(lifetimeRef.current);
    const a=auditRef.current;
    if(a && a.contractId===id){
      const accepted=Number(c.limit_order?.take_profit);
      const next:Audit={...a,settledProfit:profit,status:c.status ?? 'closed',sellPrice:Number.isFinite(Number(c.sell_price))?Number(c.sell_price):undefined,acceptedTakeProfit:c.limit_order?.take_profit!==undefined && Number.isFinite(accepted)?accepted:a.acceptedTakeProfit,verified:a.verified || (c.limit_order?.take_profit!==undefined && Math.abs(accepted-a.requestedTakeProfit)<0.005)};
      setAudit(v=>[next,...v].slice(0,50));auditRef.current=null;
      log(`AUDIT #${id}: requested TP $${a.requestedTakeProfit.toFixed(2)}; accepted TP ${next.acceptedTakeProfit===undefined?'not returned':`$${next.acceptedTakeProfit.toFixed(2)}`}; buy $${(next.buyPrice??a.proposalAsk).toFixed(2)}; exit ${next.sellPrice===undefined?'not returned':`$${next.sellPrice.toFixed(2)}`}; profit $${profit.toFixed(2)}; status ${next.status}.`);
      if(next.acceptedTakeProfit!==undefined && Math.abs(next.acceptedTakeProfit-next.requestedTakeProfit)>0.005){stop('CRITICAL: Deriv contract take-profit differs from requested value. Trading halted.');}
      // A winning settlement below the configured target needs manual inspection.
      if(profit>0 && profit+0.005<a.requestedTakeProfit){stop('Unexpected early profitable settlement below requested take-profit. Trading halted for audit.');}
    } else {stop('Settlement without matching purchase audit. Trading halted.');}
    log(`Contract ${id} settled: ${profit>=0?'+':''}${profit.toFixed(2)} USD (${c.status ?? 'closed'})`);
    if(tradesRef.current>=num(maxTrades) || pnlRef.current<=-num(maxLoss)) stop('Session limit reached.');
  },[log,maxLoss,maxTrades,stop]);
  useEffect(()=>{pricesRef.current=[];setMarketStats({samples:0,volatility:0,efficiency:0,ready:false,reason:'Collecting market ticks'});},[symbol]);
  useEffect(()=>{
    if(!ws || !isConnected || !auth.wsUrl) return;
    const remove=ws.onMessage(frame=>{
      if(frame.msg_type==='proposal_open_contract') settle(frame.proposal_open_contract as Contract);
      if(frame.msg_type==='tick') {
        const t=frame.tick as {symbol?:string;quote?:number}|undefined;
        if(t && t.symbol===symbol && Number.isFinite(Number(t.quote))){
          const price=Number(t.quote);setTick(price);tickCount.current++;
          pricesRef.current=[...pricesRef.current.slice(-119),price];
          const values=pricesRef.current;
          if(values.length>=3){
            const changes=values.slice(1).map((v,i)=>(v-values[i])/values[i]*100);
            const mean=changes.reduce((a,b)=>a+b,0)/changes.length;
            const vol=Math.sqrt(changes.reduce((a,b)=>a+(b-mean)**2,0)/changes.length);
            const movement=values.slice(1).reduce((a,v,i)=>a+Math.abs(v-values[i]),0);
            const efficiency=movement>0?Math.abs(values[values.length-1]-values[0])/movement:0;
            const enough=values.length>=Number(minTicks);
            const ready=enough && vol<=Number(maxVolatility) && efficiency>=Number(minEfficiency) && tickCount.current-lastEntryTickRef.current>=Number(cooldownTicks);
            const reason=!enough?'Collecting market ticks':vol>Number(maxVolatility)?'Volatility too high':efficiency<Number(minEfficiency)?'Momentum efficiency too low':tickCount.current-lastEntryTickRef.current<Number(cooldownTicks)?'Cooldown':'Entry conditions met';
            setMarketStats({samples:values.length,volatility:vol,efficiency,ready,reason});
          }
        }
      }
    });
    let cancelled=false;
    let unsub:(()=>Promise<void>)|undefined;
    void ws.subscribe({ticks:symbol},frame=>{
      const t=frame.tick as {quote?:number}|undefined;
      if(t && Number.isFinite(Number(t.quote)))setTick(Number(t.quote));
    }).then(sub=>{if(cancelled)void sub.unsubscribe();else unsub=sub.unsubscribe;}).catch(e=>setError(String(e)));
    return()=>{cancelled=true;remove();if(unsub)void unsub();};
  },[ws,isConnected,auth.wsUrl,symbol,settle,minTicks,maxVolatility,minEfficiency,cooldownTicks]);
  useEffect(()=>{
    if(accountRef.current!== (account?.account_id??'')) {
      accountRef.current=account?.account_id??'';
      if(runningRef.current)stop('Account changed. Trading stopped.');
    }
  },[account?.account_id,stop]);
  useEffect(()=>{
    if(!isConnected && runningRef.current)stop('Connection lost. Trading stopped; check open contracts in Deriv.');
  },[isConnected,stop]);
  // Keep contract monitoring active even after Stop; no new purchases are sent after Stop.
  useEffect(()=>{
    if(!ws || !isConnected || !openId) return;
    let disposed=false;
    let unsubscribe:(()=>Promise<void>)|undefined;
    void ws.subscribe({proposal_open_contract:1,contract_id:openId},frame=>settle(frame.proposal_open_contract as Contract))
      .then(sub=>{if(disposed)void sub.unsubscribe();else unsubscribe=sub.unsubscribe;})
      .catch(e=>{setError(`Contract monitoring failed: ${String(e)}. Check Deriv positions.`);stop('Contract monitoring unavailable.');});
    return()=>{disposed=true;if(unsubscribe)void unsubscribe();};
  },[ws,isConnected,openId,settle,stop]);
  const buyOnce=useCallback(async()=>{
    if(!ws || !runningRef.current || busyRef.current || openRef.current!==null)return;
    if(momentumEnabled && !marketStats.ready)return;
    if(tradesRef.current>=num(maxTrades) || pnlRef.current-num(stake)<-num(maxLoss)){stop('Trade or loss limit reached.');return;}
    busyRef.current=true;setPending(true);
    const epoch=session.current;
    try {
      const requestedTP=num(takeProfit);
      lastEntryTickRef.current=tickCount.current;
      const requestedStake=num(stake);
      log(`REQUEST: account ${accountRef.current}, ${symbol}, stake $${requestedStake.toFixed(2)}, growth ${(num(growth)*100).toFixed(0)}%, take-profit $${requestedTP.toFixed(2)}.`);
      const response=await ws.send<{proposal?:{id?:string;ask_price?:number;payout?:number}} >({proposal:1,amount:num(stake),basis:'stake',contract_type:'ACCU',currency:'USD',underlying_symbol:symbol,growth_rate:num(growth),limit_order:{take_profit:num(takeProfit)}});
      const proposal=response.proposal;
      if(!proposal?.id || !Number.isFinite(Number(proposal.ask_price)))throw Error('Deriv returned an invalid proposal');
      if(epoch!==session.current || !runningRef.current)return;
      const price=Number(proposal.ask_price);
      if(price>num(stake)*1.02)throw Error('Proposal price exceeds configured stake tolerance');
      log(`PROPOSAL: ask $${price.toFixed(2)}, id ${proposal.id}, payout ${proposal.payout??'not provided'}; buying ACCU.`);
      // Do not automatically retry an ambiguous buy response: it may have succeeded.
      const result=await ws.send<{buy?:{contract_id?:number;buy_price?:number;price?:number}}>({buy:proposal.id,price});
      const id=Number(result.buy?.contract_id);
      if(!Number.isSafeInteger(id) || id<=0)throw Error('Buy response has no contract ID. Check positions before retrying.');
      const actualBuy=Number(result.buy?.buy_price ?? result.buy?.price ?? price);
      auditRef.current={contractId:id,account:accountRef.current,symbol,stake:requestedStake,growth:num(growth),requestedTakeProfit:requestedTP,proposalAsk:price,proposalPayout:proposal.payout,buyPrice:Number.isFinite(actualBuy)?actualBuy:undefined,verified:false};
      log(`PURCHASE: contract #${id}; paid $${actualBuy.toFixed(2)}; requested take-profit $${requestedTP.toFixed(2)}. Awaiting Deriv contract details.`);
      openRef.current=id;setOpenId(id);
      tradesRef.current++;setTrades(tradesRef.current);
      log(`Contract ${id} opened; monitoring settlement.`);
      if(epoch!==session.current)log('Bot stopped; open contract continues to settlement.');
    }catch(e){setError(String(e));stop('Order failed or status uncertain. Check Deriv positions before restarting.');}
    finally{busyRef.current=false;setPending(false);}
  },[ws,stake,maxTrades,maxLoss,symbol,growth,takeProfit,log,stop,momentumEnabled,marketStats.ready]);
  // One attempt per fresh market tick. Never loop purchase requests on an idle state.
  useEffect(()=>{
    if(!running || !authorized || pending || openId!==null || trades>=num(maxTrades))return;
    if(momentumEnabled && !marketStats.ready)return;
    if(lastEvaluatedTickRef.current===tickCount.current)return;
    lastEvaluatedTickRef.current=tickCount.current;
    void buyOnce();
  },[running,authorized,pending,openId,trades,buyOnce,maxTrades,tick,momentumEnabled,marketStats.ready]);
  function start(){
    setError('');
    if(!authorized){setError('Log in to Deriv on Digit Match first.');return;}
    if(openRef.current!==null || busyRef.current){setError('A contract or order is still pending.');return;}
    if(![stake,takeProfit,maxTrades,maxLoss].every(v=>Number.isFinite(num(v))&&num(v)>0) || !Number.isInteger(num(maxTrades))){setError('Enter valid positive trade limits.');return;}
    if(num(takeProfit)<0.01){setError('Take-profit must be a positive USD amount.');return;}
    if(momentumEnabled && (![minTicks,maxVolatility,minEfficiency,cooldownTicks].every(v=>Number.isFinite(Number(v))) || num(minTicks)<10 || num(minTicks)>120 || num(maxVolatility)<=0 || num(minEfficiency)<0 || num(minEfficiency)>1 || num(cooldownTicks)<0)){setError('Invalid momentum filter settings.');return;}
    if(num(maxLoss)<num(stake)){setError('Maximum loss must be at least one stake.');return;}
    if(account?.account_type!=='demo' && !confirmLive){setError('Confirm real-money trading before starting.');return;}
    tradesRef.current=0;pnlRef.current=0;setTrades(0);setPnl(0);
    session.current++;runningRef.current=true;setRunning(true);lastEvaluatedTickRef.current=-1;
    log(`Started on ${account?.account_id} (${account?.account_type ?? 'unknown'}).`);
  }
  const field='mt-1 w-full rounded-lg border border-white/10 bg-[#111c31] px-2.5 py-2 text-sm text-slate-100 focus:border-cyan-400 outline-none';
  const label='block text-xs font-semibold uppercase tracking-wider text-slate-400';
  const card='rounded-xl border border-white/10 bg-[#10192a] p-3';
  return <main className="min-h-screen bg-[#080e1b] px-3 py-4 text-slate-100"><div className="mx-auto max-w-6xl space-y-3">
    <header className="flex flex-wrap items-center justify-between gap-4"><div><div className="text-xs font-bold uppercase tracking-[.2em] text-cyan-300">DigitMatchStars / Trading Suite</div><h1 className="text-2xl font-black">Accumulator <span className="text-cyan-300">PRO</span></h1></div><Link href="/" className="rounded-xl border border-white/20 px-4 py-2">← Digit Match</Link></header>
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{[['ENGINE',running?'RUNNING':'STOPPED'],['ACCOUNT',account?.account_id??'LOGIN REQUIRED'],['OPEN CONTRACT',openId??'—'],['SESSION P/L',`${pnl.toFixed(2)} USD`]].map(([a,b])=><div key={String(a)} className={card}><div className="text-xs text-slate-400">{a}</div><div className="mt-2 break-all text-lg font-bold text-cyan-300">{b}</div></div>)}</div>
    <div className="grid gap-3 lg:grid-cols-2"><section className={card}><h2 className="mb-2 text-base font-bold">01 / Trade configuration</h2><div className="mb-4 rounded-xl bg-slate-900 p-3 text-sm">{authorized?`● Connected to ${account?.account_type?.toUpperCase()} account ${account?.account_id}`:'○ Not connected — sign in through Digit Match first.'}</div><div className="grid gap-2 sm:grid-cols-2">
      <label className={label}>Symbol<input className={field} value={symbol} onChange={e=>setSymbol(e.target.value)} disabled={running||pending}/></label>
      <label className={label}>Stake (USD)<input className={field} type="number" min="0.01" step="0.01" value={stake} onChange={e=>setStake(e.target.value)} disabled={running||pending}/></label>
      <label className={label}>Growth rate<select className={field} value={growth} onChange={e=>setGrowth(e.target.value)} disabled={running||pending}>{[1,2,3,4,5].map(n=><option key={n} value={(n/100).toFixed(2)}>{n}% per tick</option>)}</select></label>
      <label className={label}>Take-profit (USD)<input className={field} type="number" min="0.01" step="0.01" value={takeProfit} onChange={e=>setTakeProfit(e.target.value)} disabled={running||pending}/></label>
      <label className={label}>Max trades<input className={field} type="number" min="1" step="1" value={maxTrades} onChange={e=>setMaxTrades(e.target.value)} disabled={running||pending}/></label>
      <label className={label}>Max loss (USD)<input className={field} type="number" min="0.01" step="0.01" value={maxLoss} onChange={e=>setMaxLoss(e.target.value)} disabled={running||pending}/></label>
    </div>{account && account.account_type!=='demo' && <label className="mt-4 flex gap-2 rounded-xl border border-amber-400/30 p-3 text-sm text-amber-200"><input type="checkbox" checked={confirmLive} onChange={e=>setConfirmLive(e.target.checked)}/>I authorize real-money accumulator orders on this account.</label>}
    <div className="mt-3 rounded-lg border border-white/10 p-2"><label className="flex items-center gap-2 text-xs font-bold"><input type="checkbox" checked={momentumEnabled} onChange={e=>setMomentumEnabled(e.target.checked)} disabled={running||pending}/> Momentum + volatility entry filter</label><div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4"><label className={label}>Min ticks<input className={field} type="number" min="10" max="120" value={minTicks} onChange={e=>setMinTicks(e.target.value)} disabled={running}/></label><label className={label}>Max vol %<input className={field} type="number" min="0.001" step="0.01" value={maxVolatility} onChange={e=>setMaxVolatility(e.target.value)} disabled={running}/></label><label className={label}>Min efficiency<input className={field} type="number" min="0" max="1" step="0.05" value={minEfficiency} onChange={e=>setMinEfficiency(e.target.value)} disabled={running}/></label><label className={label}>Cooldown ticks<input className={field} type="number" min="0" step="1" value={cooldownTicks} onChange={e=>setCooldownTicks(e.target.value)} disabled={running}/></label></div><div className="mt-2 text-xs text-slate-300">{marketStats.samples} ticks · volatility {marketStats.volatility.toFixed(4)}% · efficiency {marketStats.efficiency.toFixed(2)} · <strong className={marketStats.ready?'text-emerald-400':'text-amber-300'}>{momentumEnabled?marketStats.reason:'Filter off'}</strong></div><p className="mt-1 text-[11px] text-slate-500">These filters are experimental; momentum does not guarantee accumulator barrier survival.</p></div>
    <div className="mt-3"><button onClick={()=>running?stop():start()} disabled={running?false:(!authorized||pending||openId!==null)} className={`w-full rounded-lg px-4 py-2.5 font-black disabled:opacity-40 ${running?'border border-rose-400/50 bg-rose-500/15 text-rose-300':'bg-emerald-400 text-slate-950'}`}>{running?'■ STOP TRADING':`▶ START ${account?.account_type?.toUpperCase()??'TRADING'}`}</button></div>{error && <div role="alert" className="mt-4 rounded-xl border border-rose-400/40 p-3 text-sm text-rose-200">{error}</div>}</section>
    <section className={card}><h2 className="mb-2 text-base font-bold">02 / Live execution</h2><div className="space-y-1">{[['Connection',authorized?'CONNECTED':'DISCONNECTED'],['Market',symbol],['Last quote',tick??'Waiting for ticks'],['Trades',`${trades} / ${maxTrades}`],['Order status',pending?'REQUEST IN FLIGHT':openId?'CONTRACT OPEN':running?'READY':'IDLE']].map(([a,b])=><div key={String(a)} className="flex justify-between gap-3 rounded-xl bg-[#080e1b] p-2"><span className="text-slate-400">{a}</span><strong className="break-all text-right">{b}</strong></div>)}</div><p className="mt-2 rounded-lg border border-amber-400/20 p-2 text-xs leading-5 text-amber-100">Stopping prevents new purchases; it does not sell an open accumulator. Closing this page or losing connection can interrupt contract monitoring. Check your Deriv open positions before restarting. Strategy profitability is not established.</p></section></div>
    <section className={card}><h2 className="mb-2 text-base font-bold">03 / Contract audit</h2><p className="mb-3 text-sm text-slate-400">Each order records the exact take-profit requested. Accepted values are shown only when returned by Deriv; an absent value is not confirmation. Cumulative P/L across starts this page: <strong className="text-cyan-300">${lifetimePnl.toFixed(2)}</strong>.</p><div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-xs"><thead><tr className="text-slate-400">{['Contract','Requested TP','Deriv TP','Stake','Buy','Exit','Profit','Status'].map(h=><th key={h} className="p-2">{h}</th>)}</tr></thead><tbody>{audit.map(a=><tr key={a.contractId} className="border-t border-white/10"><td className="p-2">{a.contractId}</td><td className="p-2">${a.requestedTakeProfit.toFixed(2)}</td><td className="p-2">{a.acceptedTakeProfit===undefined?'Not returned':`$${a.acceptedTakeProfit.toFixed(2)}`}</td><td className="p-2">${a.stake.toFixed(2)}</td><td className="p-2">${(a.buyPrice??a.proposalAsk).toFixed(2)}</td><td className="p-2">{a.sellPrice===undefined?'—':`$${a.sellPrice.toFixed(2)}`}</td><td className={`p-2 font-black ${a.settledProfit!==undefined?(a.settledProfit>=0?'text-green-400':'text-red-400'):''}`}>{a.settledProfit===undefined?'—':`${a.settledProfit>=0?'+':''}${a.settledProfit.toFixed(2)}`}</td><td className={`p-2 font-black ${a.settledProfit!==undefined?(a.settledProfit>=0?'text-green-400':'text-red-400'):''}`}>{a.status??'—'}</td></tr>)}</tbody></table></div>{!audit.length&&<p className="text-sm text-slate-400">No completed trades recorded on this page yet.</p>}</section>
    <section className={card}><h2 className="mb-2 text-base font-bold">04 / Execution events</h2><div className="max-h-80 min-h-32 space-y-2 overflow-auto font-mono text-xs">{events.length?events.slice().reverse().map((e,i)=><div key={i} className="rounded-lg bg-[#080e1b] p-3"><span className="text-cyan-300">{e.time}</span> <span className={e.message.includes("settled:")||e.message.includes("AUDIT #")?(e.message.includes("settled: -")||/profit \$-/.test(e.message)?"font-black text-red-400":"font-black text-green-400"):""}>{e.message}</span></div>):'No events yet.'}</div></section>
  </div></main>;
}
