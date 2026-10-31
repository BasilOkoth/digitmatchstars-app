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
function digitEntropy(counts: number[], total: number) {
  if (!total) return null;
  return -counts.reduce((acc, count) => {
    if (!count) return acc;
    const p = count / total;
    return acc + p * Math.log2(p);
  }, 0);
}

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
  const baselineMatches = useMemo(() => trials.filter(t => t.baseline === t.observed).length, [trials]);
  const n = trials.length;
  const rate = n ? matches / n : null;
  const baselineRate = n ? baselineMatches / n : null;
  const entropy = digitEntropy(digitStats.counts, digitStats.totalTicks);
  const breakEven = proposal && proposal.payout > 0 ? proposal.askPrice / proposal.payout : null;
  // Deriv profit_table returns a capped recent history, not a cycle report.
  const relevant = closedPositions.filter(p => p.underlying_symbol === symbol);
  const paid = relevant.reduce((sum, p) => sum + Number(p.buy_price || 0), 0);
  const received = relevant.reduce((sum, p) => sum + Number(p.sell_price || 0), 0);
  const net = received - paid;
  const assessment = n < 200 ? 'Insufficient observations' : breakEven === null ? 'Waiting for a valid payout quote' : (rate ?? 0) > breakEven ? 'Above quoted break-even in sample — not proof of edge' : 'Not above quoted break-even in sample';

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
            <Metric label="Control baseline hit rate" value={baselineRate === null ? '—' : percent(baselineRate)} sub="Fixed rotating digit baseline" />
            <Metric label="Quoted match break-even" value={breakEven === null ? '—' : percent(breakEven)} sub="Quote price ÷ quote payout" />
            <Metric label="Digit entropy" value={entropy === null ? '—' : `${entropy.toFixed(3)} bits`} sub="Max is 3.322 bits for uniform digits" />
            <Metric label="Frequency sample" value={digitStats.totalTicks.toLocaleString()} sub="Ticks in the app's statistics window" />
            <Metric label="Recent closed contracts" value={String(relevant.length)} sub="For current symbol; API history limited to 50" />
            <Metric label="Recent net closed P/L" value={relevant.length ? money(net) : '—'} sub="Sell credits minus buy prices, not cycle P/L" />
          </div>
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <span className="font-medium">Statistical assessment: </span>{assessment}
            <p className="mt-1 text-xs text-muted-foreground">Selected-digit accuracy is checked against the NEXT tick; changing the selected digit between ticks changes the next test. The control baseline is deterministic, not a predictive model. Samples are not independent proof of profitability. This is not the Python bot's proprietary score.</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Observed digit frequencies</h3>
              {digitStats.counts.map((count, digit) => (
                <div className="flex items-center gap-2 text-xs" key={digit}>
                  <span className="w-4 font-mono">{digit}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded bg-muted"><div className="h-full rounded bg-blue-500" style={{ width: `${digitStats.percentages[digit] ?? 0}%` }} /></div>
                  <span className="w-16 text-right tabular-nums">{(digitStats.percentages[digit] ?? 0).toFixed(1)}%</span>
                  <span className="w-9 text-right text-muted-foreground">{count}</span>
                </div>
              ))}
            </div>
            <div className="space-y-2 text-sm">
              <h3 className="font-semibold">Trade reconciliation summary</h3>
              <div className="flex justify-between"><span>Account</span><span className="font-mono text-xs">{accountKey || 'Not signed in'}</span></div>
              <div className="flex justify-between"><span>Symbol</span><span>{symbol || '—'}</span></div>
              <div className="flex justify-between"><span>Buy prices, recent closed</span><span>${paid.toFixed(2)}</span></div>
              <div className="flex justify-between"><span>Sell payouts, recent closed</span><span>${received.toFixed(2)}</span></div>
              <div className="flex justify-between border-t pt-2 font-semibold"><span>Net P/L, recent closed</span><span>{relevant.length ? money(net) : '—'}</span></div>
              <p className="text-xs text-muted-foreground">Based on the Deriv profit_table response. Up to 50 recent closed records are retrieved, possibly across symbols and sessions. This is NOT an all-time or Martingale-cycle profit calculation. Use full Deriv statement reconciliation for that.</p>
            </div>
          </div>
          <p className="border-t pt-3 text-xs text-muted-foreground">Research analytics do not predict future results. Samples persist in this browser; clearing browser storage removes them. The proprietary scoring algorithm was not available in this app ZIP; integrating the existing Render model requires its algorithm/API. The display does not trigger any trades.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value, sub }: {label: string; value: string; sub: string}) {
  return <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums">{value}</p><p className="mt-1 text-[11px] text-muted-foreground">{sub}</p></div>;
}
