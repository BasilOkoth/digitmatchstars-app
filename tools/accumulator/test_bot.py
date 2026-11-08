"""Offline unit checks; no Deriv orders or network access."""
import asyncio, os, tempfile, unittest
from bot import Bot, Config

class TestAccumulatorSafety(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.cwd=os.getcwd();self.tmp=tempfile.TemporaryDirectory();os.chdir(self.tmp.name)
        self.c=Config('demo','unused','unused','unused','1HZ100V','USD',1,.02,.2,10,.06,.025,3,1,0,2)
        self.bot=Bot(self.c)
    async def asyncTearDown(self):
        self.bot.logfile.close();os.chdir(self.cwd);self.tmp.cleanup()
    async def test_no_entry_when_stake_exceeds_remaining_loss_budget(self):
        self.bot.pnl=-.5
        for n in range(12): await self.bot.tick({'quote':100})
        self.assertTrue(self.bot.stopped)
        self.assertFalse(self.bot.buy_in_flight)
    async def test_open_position_blocks_additional_entries(self):
        self.bot.open_id=123
        for n in range(15):await self.bot.tick({'quote':100})
        self.assertEqual(self.bot.trades,0)
    async def test_settlement_updates_pnl_once(self):
        self.bot.open_id=123
        self.bot.contract_update({'contract_id':123,'is_sold':1,'profit':-.5,'status':'lost'})
        self.bot.contract_update({'contract_id':123,'is_sold':1,'profit':-.5,'status':'lost'})
        self.assertEqual(self.bot.pnl,-.5)
        self.assertIsNone(self.bot.open_id)
    async def test_unsolicited_contract_update_is_ignored(self):
        self.bot.contract_update({'contract_id':999,'is_sold':1,'profit':-4,'status':'lost'})
        self.assertEqual(self.bot.pnl,0)
        self.assertIsNone(self.bot.open_id)
    async def test_stale_signal_does_not_purchase(self):
        self.bot.buy_in_flight=True;self.bot.entry_tick=1;self.bot.tick_no=5
        calls=[]
        async def send(payload):
            calls.append(payload)
            return {'proposal':{'id':'test','ask_price':1}}
        self.bot.send=send
        await self.bot.purchase({'volatility_pct':0,'mean_abs_drift_pct':0})
        self.assertEqual(len(calls),1)
        self.assertFalse(self.bot.buy_in_flight)

if __name__=='__main__':unittest.main()
