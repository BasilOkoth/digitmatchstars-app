'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Tick } from '@deriv/core';
import { getLastDigit } from '@/lib/digit-stats';
import { scoreDigits } from '@/lib/digitmatch-score';
import { Localize } from '@deriv-com/translations';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { DigitStats } from '../lib/types';

type ScoreMap = Record<number, number>;
const ScoreContext = createContext<ScoreMap>({});
/** Uses the SAME scoreDigits routine as the automated engine; values are
 * relative scores, NOT probabilities. The 100-tick sample resets on symbol change. */
export function DigitScoreProvider({children, tick, pipSize, symbol}: {
 children: React.ReactNode; tick: Tick | null; pipSize: number; symbol: string;
}) {
 const [scores, setScores] = useState<ScoreMap>({});
 const history = useRef<number[]>([]);
 const lastKey = useRef('');
 useEffect(() => {history.current=[];lastKey.current='';setScores({});},[symbol,pipSize]);
 useEffect(() => {
   if (!tick || !symbol || !Number.isFinite(tick.quote)) return;
   const key = `${tick.epoch}:${tick.quote}`;
   if (key === lastKey.current) return;
   lastKey.current = key;
   history.current = [...history.current.slice(-99),getLastDigit(tick.quote,pipSize)];
   const next: ScoreMap = {};
   for(const item of scoreDigits(history.current)) next[item.digit] = item.score;
   setScores(next);
 }, [tick,symbol,pipSize]);
 return <ScoreContext.Provider value={scores}>{children}</ScoreContext.Provider>;
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
      <span className="text-xs sm:text-sm text-muted-foreground mb-1.5">
        <Localize i18n_default_text="Last digit prediction" />
      </span>
      <div className="flex-1 flex items-center min-h-0">
        <div className="grid grid-cols-5 gap-2 lg:grid-cols-10 place-items-center w-full">
        {rankedDigits.map((digit) => {
          const pct = digitStats.percentages[digit] ?? 0;
          const isSelected = digit === selectedDigit;
          const isHighest = digitStats.totalTicks > 0 && pct === maxPct;
          const isLowest = digitStats.totalTicks > 0 && pct === minPct;

          return (
            <div key={digit} className="flex flex-col items-center gap-0.5">
              <Button
                variant={isSelected ? 'default' : 'outline'}
                onClick={() => onDigitSelect(digit)}
                className={cn(
                  'w-9 h-9 sm:w-10 sm:h-10 text-sm sm:text-base font-semibold rounded-lg p-0',
                  !isSelected && 'bg-muted/50 border-muted-foreground/20'
                )}
              >
                {digit}
              </Button>
              <span
                className={cn(
                  'text-[11px] font-mono',
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
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
}
