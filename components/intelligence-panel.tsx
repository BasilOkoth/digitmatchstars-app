'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { Tick, ProposalInfo } from '@deriv/core';
import type { ClosedPosition, DigitStats } from '@/lib/types';
import { getLastDigit } from '@/lib/digit-stats';

type Trial = { candidate: number; baseline: number; observed: number };
const MAX_TRIALS = 10000;
function percent(num: number) { return `${(num * 100).toFixed(2)}%`; }
function money(num: number) { return `${num >= 0 ? '+' : '-'}$${Math.abs(num).toFixed(2)}`; }

/** Research UI ONLY: records next-tick accuracy of the digit currently selected by the user.
 * It does not calculate the separate Render bot's proprietary scoring algorithm or place trades.
 */
export function IntelligencePanel({
  currentTick, pipSize, selectedDigit, symbol, digitStats, proposal, closedPositions, accountKey,
}: {
  currentTick: Tick | null;
  pipSize: number;
  selectedDigit: number;
  symbol: string;
  digitStats: DigitStats;
  proposal: ProposalInfo | null;
  closedPositions: ClosedPosition[];
  accountKey: string;
}) {
  const [trials, setTrials] = useState<Trial[]>([]);
  const lastTick = useRef<string>('');
  const previousPrediction = useRef<{ selected: number; baseline: number } | null>(null);
  const tickCount = useRef(0);
  const scope = `${accountKey}:${symbol}:${pipSize}`;

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(`dms-research:${scope}`);
      const data = saved ? JSON.parse(saved) : [];
      setTrials(Array.isArray(data) ? data.filter((t: Trial) => Number.isInteger(t.candidate) && Number.isInteger(t.baseline) && Number.isInteger(t.observed)).slice(-MAX_TRIALS) : []);
    } catch { setTrials([]); }
    lastTick.current = '';
    previousPrediction.current = null;
    tickCount.current = 0;
  }, [scope]);

  useEffect(() => {
    if (!currentTick || !symbol || !Number.isFinite(currentTick.quote)) return;
    // Dedupe React rerenders; a new tick with the same value but a new epoch still counts.
    const identity = `${currentTick.epoch}:${currentTick.quote}`;
    if (identity === lastTick.current) return;
    lastTick.current = identity;
    const observed = getLastDigit(currentTick.quote, pipSize);
    const prev = previousPrediction.current;
    if (prev) {
      setTrials(old => [...old.slice(-(MAX_TRIALS - 1)), {candidate: prev.selected, baseline: prev.baseline, observed}]);
    }
    // Deterministic baseline unrelated to the observed digit; for comparison, not a signal.
    const baseline = (tickCount.current * 7 + 3) % 10;
    previousPrediction.current = {selected: selectedDigit, baseline};
    tickCount.current++;
  }, [currentTick, pipSize, selectedDigit, symbol]);

  useEffect(() => {
    if (!symbol) return;
    try { window.localStorage.setItem(`dms-research:${scope}`, JSON.stringify(trials)); } catch { /* Browsers can disable storage. */ }
  }, [scope, trials, symbol]);

  const matches = useMemo(() => trials.filter(t => t.candidate === t.observed).length, [trials]);
  const n = trials.length;
  const rate = n ? matches / n : null;
  const breakEven = proposal && proposal.payout > 0 ? proposal.askPrice / proposal.payout : null;
  // Deriv profit_table returns a capped recent history, not a cycle report.
  const relevant = closedPositions.filter(p => p.underlying_symbol === symbol);
  const paid = relevant.reduce((sum, p) => sum + Number(p.buy_price || 0), 0);
  const received = relevant.reduce((sum, p) => sum + Number(p.sell_price || 0), 0);
  const net = received - paid;

  return (
    <div className="mx-auto w-full max-w-5xl px-3 pb-24 pt-3 sm:px-4" data-testid="intelligence-panel">
      <Card className="border-blue-500/30">
        <CardHeader className="space-y-1 pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-lg">DigitMatchStars Intelligence</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">Live research measurements. Demo trade controls appear above; no unattended trading.</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => { setTrials([]); try { window.localStorage.removeItem(`dms-research:${scope}`); } catch {} previousPrediction.current = null; lastTick.current = ''; tickCount.current = 0; }}>Reset sample</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Next-tick predictions tested" value={n.toLocaleString()} sub="Saved in this browser for the current account and symbol" />
            <Metric label="Selected digit hit rate" value={rate === null ? '—' : percent(rate)} sub={`${matches} matching subsequent ticks`} />
            <Metric label="Quoted match break-even" value={breakEven === null ? '—' : percent(breakEven)} sub="Quote price ÷ quote payout" />
            <Metric label="Recent net closed P/L" value={relevant.length ? money(net) : '—'} sub="Sell credits minus buy prices, not cycle P/L" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value, sub }: {label: string; value: string; sub: string}) {
  return <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums">{value}</p><p className="mt-1 text-[11px] text-muted-foreground">{sub}</p></div>;
}
