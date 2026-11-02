'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Tick } from '@deriv/core';
import { getLastDigit } from '@/lib/digit-stats';
import { scoreDigits } from '@/lib/digitmatch-score';
import { estimateArrivalTicks } from '@/lib/digit-urgency';
import { Localize } from '@deriv-com/translations';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { DigitStats } from '../lib/types';

type ScoreMap = Record<number, number>;
const ScoreContext = createContext<ScoreMap>({});
const ArrivalContext = createContext<Record<number, number>>({});
type MomentumReading = { change: number; rises: number; rising: boolean };
const MomentumContext = createContext<Record<number, MomentumReading>>({});
const ExecutionTargetContext = createContext<{ target: number | null; setTarget: (digit: number | null) => void }>({target:null,setTarget:()=>{}});
export function useExecutionTarget() { return useContext(ExecutionTargetContext); }
/** Uses the SAME scoreDigits routine as the automated engine; values are
 * relative scores, NOT probabilities. The 100-tick sample resets on symbol change. */
export function DigitScoreProvider({children, tick, pipSize, symbol}: {
 children: React.ReactNode; tick: Tick | null; pipSize: number; symbol: string;
}) {
 const [scores, setScores] = useState<ScoreMap>({});
 const [arrival, setArrival] = useState<Record<number, number>>({});
 const [momentum, setMomentum] = useState<Record<number, MomentumReading>>({});
 const scoreSnapshots = useRef<ScoreMap[]>([]);
 const [target, setTarget] = useState<number | null>(null);
 const history = useRef<number[]>([]);
 const lastKey = useRef('');
 useEffect(() => {history.current=[];scoreSnapshots.current=[];lastKey.current='';setScores({});setMomentum({});setArrival({});setTarget(null);},[symbol,pipSize]);
 useEffect(() => {
   if (!tick || !symbol || !Number.isFinite(tick.quote)) return;
   const key = `${tick.epoch}:${tick.quote}`;
   if (key === lastKey.current) return;
   lastKey.current = key;
   history.current = [...history.current.slice(-99),getLastDigit(tick.quote,pipSize)];
   const next: ScoreMap = {};
   for(const item of scoreDigits(history.current)) next[item.digit] = item.score;
   // Same three-step definition used by IntegratedBot: positive net
   // score movement plus at least two increases in the last three steps.
   if (Object.keys(next).length === 10) {
     scoreSnapshots.current = [...scoreSnapshots.current.slice(-3), next];
   }
   const four = scoreSnapshots.current;
   const movements: Record<number, MomentumReading> = {};
   if (four.length === 4) {
     for (let digit = 0; digit < 10; digit++) {
       const changes = [1, 2, 3].map(i => four[i][digit] - four[i-1][digit]);
       const change = four[3][digit] - four[0][digit];
       const rises = changes.filter(x => x > 0).length;
       movements[digit] = {change, rises, rising: change > 0 && rises >= 2};
     }
   }
   setMomentum(movements);
   setScores(next);
   setArrival(estimateArrivalTicks(history.current));
 }, [tick,symbol,pipSize]);
 return <ScoreContext.Provider value={scores}><ArrivalContext.Provider value={arrival}><MomentumContext.Provider value={momentum}><ExecutionTargetContext.Provider value={{target,setTarget}}>{children}</ExecutionTargetContext.Provider></MomentumContext.Provider></ArrivalContext.Provider></ScoreContext.Provider>;
}

interface DigitStatsBarProps {
  digitStats: DigitStats;
  selectedDigit: number;
  onDigitSelect: (digit: number) => void;
}

export function DigitStatsBar({
  digitStats,
  selectedDigit,
  onDigitSelect,
}: DigitStatsBarProps) {
  const scoreByDigit = useContext(ScoreContext);
  const arrivalByDigit = useContext(ArrivalContext);
  const momentumByDigit = useContext(MomentumContext);
  const maxPct = Math.max(...digitStats.percentages);
  const minPct = Math.min(...digitStats.percentages);
  const rankedDigits = [...Array(10).keys()].sort((a,b) => {
    const aScore=scoreByDigit[a], bScore=scoreByDigit[b];
    if (Number.isFinite(aScore) && Number.isFinite(bScore)) return bScore-aScore || a-b;
    if (Number.isFinite(aScore)) return -1;
    if (Number.isFinite(bScore)) return 1;
    return a-b;
  });

  return (
    <div className="h-full flex flex-col min-h-0">
      <span className="text-xs sm:text-sm text-muted-foreground mb-2 sm:mb-3">
        <Localize i18n_default_text="Last digit prediction" />
      </span>
      <div className="flex-1 flex items-center min-h-0">
        <div className="grid grid-cols-5 gap-1.5 sm:gap-3 place-items-center w-full">
        {rankedDigits.map((digit) => {
          const pct = digitStats.percentages[digit] ?? 0;
          // Green always shows the current highest V1 score. An in-flight contract may target a prior digit.
          const isSelected = digit === (Number.isFinite(scoreByDigit[rankedDigits[0]]) ? rankedDigits[0] : null);
          const isHighest = digitStats.totalTicks > 0 && pct === maxPct;
          const isLowest = digitStats.totalTicks > 0 && pct === minPct;

          return (
            <div key={digit} className="flex flex-col items-center gap-1 sm:gap-1.5">
              <Button
                variant={isSelected ? 'default' : 'outline'}
                onClick={() => onDigitSelect(digit)}
                className={cn(
                  'w-11 h-11 sm:w-14 sm:h-14 text-base sm:text-xl font-bold rounded-lg p-0',
                  isSelected && 'bg-green-600 text-white border-green-400 ring-2 ring-green-400/70 hover:bg-green-500 focus-visible:ring-green-400 shadow-md shadow-green-950/40',
                  !isSelected && 'bg-muted/50 border-muted-foreground/20'
                )}
              >
                {digit}
              </Button>
              <span
                className={cn(
                  'text-xs font-mono',
                  isHighest && 'text-green-500 font-semibold',
                  isLowest && 'text-red-500 font-semibold',
                  !isHighest && !isLowest && 'text-muted-foreground'
                )}
              >
                {pct.toFixed(1)}%
              </span>
              <span className="text-[10px] font-semibold tabular-nums text-cyan-400" title="Relative execution score, not probability">
                {Number.isFinite(scoreByDigit[digit]) ? `Score ${scoreByDigit[digit].toFixed(2)}` : 'Score —'}
              </span>
              <span className={cn('text-[11px] font-extrabold tabular-nums whitespace-nowrap',
                momentumByDigit[digit]?.rising ? 'text-green-400' : 'text-red-400')}
                title="3-tick V1 score change; rising requires two of three increases and positive overall change">
                {momentumByDigit[digit]
                  ? `${momentumByDigit[digit].rising ? '▲' : momentumByDigit[digit].change < 0 ? '▼' : '▬'} ${momentumByDigit[digit].change >= 0 ? '+' : ''}${momentumByDigit[digit].change.toFixed(2)}`
                  : '—'}
              </span>
              <span className="text-[10px] font-semibold tabular-nums text-emerald-400/90" title="Approximate historical gap between appearances, smoothed toward 10 ticks. Not a prediction or guaranteed trade count.">
                {Number.isFinite(arrivalByDigit[digit]) ? `Est. ~${arrivalByDigit[digit]} ticks` : 'Est. —'}
              </span>
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
}
