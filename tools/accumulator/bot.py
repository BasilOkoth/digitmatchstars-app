"""Deriv ACCU demo/real execution; no simulated orders."""
import argparse, asyncio, collections, json, math, os, statistics, sys, time
from dataclasses import dataclass
import httpx
import websockets

API='https://api.derivws.com'

@dataclass
class Config:
    mode:str; token:str; app_id:str; account_id:str; symbol:str; currency:str
    stake:float; growth:float; take_profit:float; window:int; max_vol:float
    max_drift:float; max_trades:int; max_loss:float; cooldown:int; max_signal_age:int

class Bot:
    def __init__(self,c):
        self.c=c; self.prices=collections.deque(maxlen=1000); self.returns=collections.deque(maxlen=1000)
        self.pending={}; self.seq=0; self.ws=None; self.open_id=None; self.trades=0; self.pnl=0.0
        self.last_trade_tick=-100000; self.tick_no=0; self.stopped=False; self.last_quote=None; self.buy_in_flight=False; self.entry_tick=None
        self.logfile=open('accumulator_trades.jsonl','a',encoding='utf-8')

    def log(self,kind,**data):
        row={'time':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'event':kind,'mode':self.c.mode,**data}
        print(json.dumps(row,default=str),flush=True)
        self.logfile.write(json.dumps(row,default=str)+'\n');self.logfile.flush()

    async def send(self,payload):
        self.seq+=1; n=self.seq; payload={**payload,'req_id':n}
        fut=asyncio.get_running_loop().create_future();self.pending[n]=fut
        await self.ws.send(json.dumps(payload))
        try: return await asyncio.wait_for(fut,timeout=18)
        finally:self.pending.pop(n,None)

    async def reader(self):
        async for raw in self.ws:
            msg=json.loads(raw); n=msg.get('req_id'); f=self.pending.get(n)
            if f is not None and not f.done():
                if msg.get('error'):f.set_exception(RuntimeError(str(msg['error'])))
                else:f.set_result(msg)
            typ=msg.get('msg_type')
            if msg.get('error') and f is None:self.log('stream_error',error=msg['error'])
            if typ=='tick' and msg.get('tick'):await self.tick(msg['tick'])
            if typ=='proposal_open_contract' and msg.get('proposal_open_contract'):
                self.contract_update(msg['proposal_open_contract'])

    def contract_update(self,p):
        cid=p.get('contract_id')
        if not cid or (self.open_id is not None and str(cid)!=str(self.open_id)):return
        if p.get('is_sold') or p.get('is_expired') or p.get('status') in ('won','lost','sold'):
            profit=float(p.get('profit') or 0)
            if self.open_id is not None:
                self.pnl+=profit;self.log('settled',contract_id=cid,status=p.get('status'),profit=profit,total_pnl=round(self.pnl,2))
                self.open_id=None
                if self.pnl<=-self.c.max_loss:self.stopped=True;self.log('daily_loss_limit_reached')
        elif self.open_id is not None:
            self.log('position',contract_id=cid,profit=p.get('profit'),bid_price=p.get('bid_price'),status=p.get('status'))

    def metrics(self):
        a=list(self.returns)[-self.c.window:]
        if len(a)<self.c.window:return None
        vol=statistics.pstdev(a); drift=abs(statistics.mean(a));
        return {'volatility_pct':vol,'mean_abs_drift_pct':drift}

    async def tick(self,t):
        price=float(t['quote']);self.tick_no+=1
        if self.prices:self.returns.append((price/self.prices[-1]-1)*100)
        self.prices.append(price);self.last_quote=price
        m=self.metrics()
        if self.tick_no%10==0:self.log('tick',tick=self.tick_no,price=price,metrics=m)
        if self.stopped or self.open_id is not None or self.buy_in_flight or self.trades>=self.c.max_trades:return
        # A full stake may be lost; never initiate if it exceeds remaining loss budget.
        if self.c.stake > self.c.max_loss + self.pnl + 1e-9:
            self.stopped=True;self.log('loss_budget_exhausted',remaining=round(self.c.max_loss+self.pnl,2));return
        if self.tick_no-self.last_trade_tick<self.c.cooldown:return
        if m is None or m['volatility_pct']>self.c.max_vol or m['mean_abs_drift_pct']>self.c.max_drift:return
        # One trade at a time. No purchase while an earlier buy is pending.
        self.buy_in_flight=True; self.entry_tick=self.tick_no
        asyncio.create_task(self.purchase(m))

    async def purchase(self,m):
        try:
            self.log('entry_signal',tick=self.tick_no,metrics=m)
            # ACCU take-profit is broker-side; actual barrier is broker-defined, not synthetic.
            req={'proposal':1,'amount':self.c.stake,'basis':'stake','contract_type':'ACCU',
                 'currency':self.c.currency,'underlying_symbol':self.c.symbol,
                 'growth_rate':self.c.growth,'limit_order':{'take_profit':self.c.take_profit}}
            proposal=(await self.send(req))['proposal']
            # A proposal generated many ticks after the signal is not a tick-synchronised entry.
            if self.tick_no-self.entry_tick>self.c.max_signal_age:
                self.log('stale_signal_skipped',signal_tick=self.entry_tick,current_tick=self.tick_no);return
            pid=proposal['id']; ask=float(proposal.get('ask_price',self.c.stake))
            if ask>self.c.stake*1.02:raise RuntimeError('Quoted ask exceeds stake tolerance')
            bought=(await self.send({'buy':pid,'price':round(ask*1.001,2)}))['buy']
            self.open_id=bought['contract_id'];self.trades+=1;self.last_trade_tick=self.tick_no
            self.log('bought',contract_id=self.open_id,stake=self.c.stake,price=bought.get('buy_price'),growth=self.c.growth,trade_number=self.trades)
            await self.send({'proposal_open_contract':1,'contract_id':self.open_id,'subscribe':1})
        except Exception as e:
            self.log('purchase_error',error=str(e))
            # An unknown buy outcome must not be treated as safely flat.
            self.stopped=True
            self.log('halted',note='Check Deriv open contracts before restarting')
        finally:
            self.buy_in_flight=False

    async def run(self):
        headers={'Authorization':'Bearer '+self.c.token,'Deriv-App-ID':self.c.app_id}
        async with httpx.AsyncClient(timeout=20) as client:
            r=await client.post(f'{API}/trading/v1/options/accounts/{self.c.account_id}/otp',headers=headers)
            r.raise_for_status();url=r.json()['data']['url']
        expected='/demo?' if self.c.mode=='demo' else '/real?'
        if expected not in url:raise RuntimeError('Account mode mismatch: OTP URL does not match selected demo/live mode')
        self.log('connected_mode',account_id=self.c.account_id,symbol=self.c.symbol)
        async with websockets.connect(url,ping_interval=20,ping_timeout=20,max_size=2**20) as self.ws:
            task=asyncio.create_task(self.reader())
            try:
                # Portfolio check before any new trades; avoid accidental stacking on restart.
                port=await self.send({'portfolio':1})
                active=port.get('portfolio',{}).get('contracts',[])
                if active:
                    self.log('existing_contracts_detected',count=len(active));raise RuntimeError('Existing contracts found; close/reconcile before running bot')
                await self.send({'ticks':self.c.symbol,'subscribe':1})
                self.log('started',stake=self.c.stake,growth=self.c.growth,take_profit=self.c.take_profit)
                while not task.done():
                    if self.stopped or self.trades>=self.c.max_trades:
                        if self.open_id is None:break
                    await asyncio.sleep(.5)
                if task.done():await task
            finally:
                task.cancel();self.log('stopped',trades=self.trades,total_pnl=round(self.pnl,2),open_contract=self.open_id)
                self.logfile.close()

def main():
    p=argparse.ArgumentParser(description='Deriv accumulator real/demo execution')
    p.add_argument('--mode',required=True,choices=['demo','live']);p.add_argument('--account-id',required=True)
    p.add_argument('--symbol',default='1HZ100V');p.add_argument('--currency',default='USD')
    p.add_argument('--stake',type=float,default=1);p.add_argument('--growth',type=float,default=.02)
    p.add_argument('--take-profit',type=float,default=.20,help='Profit in account currency, not payout')
    p.add_argument('--window',type=int,default=40);p.add_argument('--max-vol',type=float,default=.06)
    p.add_argument('--max-drift',type=float,default=.025);p.add_argument('--max-trades',type=int,default=3)
    p.add_argument('--max-loss',type=float,default=3);p.add_argument('--cooldown',type=int,default=20)
    p.add_argument('--max-signal-age',type=int,default=2,help='Skip proposals arriving more than N ticks after the entry signal')
    p.add_argument('--confirm-live',action='store_true')
    a=p.parse_args(); token=os.getenv('DERIV_TOKEN','');app=os.getenv('DERIV_APP_ID','')
    if not token or not app:p.error('Set DERIV_TOKEN and DERIV_APP_ID environment variables')
    if a.mode=='live' and not a.confirm_live:p.error('Live trading requires --confirm-live')
    if not(.01<=a.growth<=.05):p.error('Growth must be between 0.01 and 0.05')
    if (not all(math.isfinite(v) for v in (a.stake,a.growth,a.take_profit,a.max_loss,a.max_vol,a.max_drift))
        or a.stake<=0 or a.take_profit<=0 or a.max_loss<a.stake or a.window<10 or a.max_trades<1
        or a.max_vol<0 or a.max_drift<0 or a.cooldown<0 or a.max_signal_age<0):p.error('Invalid risk parameters')
    c=Config(a.mode,token,app,a.account_id,a.symbol,a.currency,a.stake,a.growth,a.take_profit,a.window,a.max_vol,a.max_drift,a.max_trades,a.max_loss,a.cooldown,a.max_signal_age)
    try:asyncio.run(Bot(c).run())
    except KeyboardInterrupt:print('Interrupted: verify open contracts in Deriv before restarting')
    except Exception as e:print(f'ERROR: {e}\nVerify any open contracts in Deriv before restarting.',file=sys.stderr);sys.exit(1)

if __name__=='__main__':main()
