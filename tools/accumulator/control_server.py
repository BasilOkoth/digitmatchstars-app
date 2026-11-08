"""Local-only control plane for the standalone Deriv accumulator process."""
import json, os, subprocess, sys, threading, time
from collections import deque
from pathlib import Path
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
import uvicorn

ROOT = Path(__file__).resolve().parent
app = FastAPI(title='DigitMatchStars Accumulator Local Control')
lock = threading.RLock()
proc = None
state = {'mode':None,'account_id':None,'started_at':None,'exit_code':None}
logs = deque(maxlen=250)

class StartRequest(BaseModel):
    mode: str
    account_id: str = Field(min_length=3, max_length=100)
    symbol: str = Field(default='1HZ100V',pattern=r'^[A-Za-z0-9_]{2,30}$')
    stake: float = Field(default=1,gt=0,le=10000)
    growth: float = Field(default=.02,ge=.01,le=.05)
    take_profit: float = Field(default=.2,gt=0)
    window: int = Field(default=40,ge=10,le=1000)
    max_vol: float = Field(default=.06,ge=0)
    max_drift: float = Field(default=.025,ge=0)
    max_trades: int = Field(default=3,ge=1,le=10000)
    max_loss: float = Field(default=3,gt=0)
    cooldown: int = Field(default=20,ge=0)
    max_signal_age: int = Field(default=2,ge=0)
    confirm_live: bool = False

def snapshot():
    with lock:
        running = proc is not None and proc.poll() is None
        return {'running':running, **state, 'logs':list(logs)[-100:]}

@app.get('/status')
def status(): return snapshot()

def read_output(p):
    global proc
    for line in p.stdout:
        with lock:
            try: logs.append(json.loads(line))
            except ValueError: logs.append({'event':'output','message':line.rstrip()})
    with lock: state['exit_code']=p.wait()

@app.post('/start')
def start(req: StartRequest):
    global proc
    with lock:
        if proc is not None and proc.poll() is None: raise HTTPException(409,'Bot already running')
        if req.mode not in ('demo','live'): raise HTTPException(400,'Invalid mode')
        if req.mode == 'live' and not req.confirm_live: raise HTTPException(400,'Explicit live confirmation required')
        if req.max_loss < req.stake: raise HTTPException(400,'Max loss must cover at least one stake')
        if not os.getenv('DERIV_TOKEN') or not os.getenv('DERIV_APP_ID'):
            raise HTTPException(400,'Configure DERIV_TOKEN and DERIV_APP_ID on the local control server')
        args=[sys.executable,'-u',str(ROOT/'bot.py'),'--mode',req.mode,'--account-id',req.account_id,
            '--symbol',req.symbol,'--stake',str(req.stake),'--growth',str(req.growth),
            '--take-profit',str(req.take_profit),'--window',str(req.window),'--max-vol',str(req.max_vol),
            '--max-drift',str(req.max_drift),'--max-trades',str(req.max_trades),'--max-loss',str(req.max_loss),
            '--cooldown',str(req.cooldown),'--max-signal-age',str(req.max_signal_age)]
        if req.mode=='live':args.append('--confirm-live')
        logs.clear()
        proc=subprocess.Popen(args,cwd=str(ROOT),stdout=subprocess.PIPE,stderr=subprocess.STDOUT,
                              text=True,bufsize=1,env=os.environ.copy())
        state.update(mode=req.mode,account_id=req.account_id,started_at=time.time(),exit_code=None)
        threading.Thread(target=read_output,args=(proc,),daemon=True).start()
    return snapshot()

@app.post('/stop')
def stop():
    with lock:
        if proc is None or proc.poll() is not None: return snapshot()
        # SIGINT is deliberately avoided: bot shutdown must not pretend open contracts are closed.
        proc.terminate()
        logs.append({'event':'stop_requested','message':'Process stopped; verify any open accumulator contract in Deriv.'})
    return snapshot()

if __name__=='__main__':
    uvicorn.run(app,host='127.0.0.1',port=int(os.getenv('ACCUMULATOR_CONTROL_PORT','8765')))
