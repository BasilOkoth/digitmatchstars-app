'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Tick } from '@deriv/core';
import { getLastDigit } from '@/lib/digit-stats';
import { scoreDigits } from '@/lib/digitmatch-score';
import { estimateArrivalTicks } from '@/lib/digit-urgency';

type Frozen = { digit: number; score: number };
type Check = {
  timestamp: number; symbol: string; pipSize: number; tickEpoch: number;
  actual: number; predicted: Frozen[]; rank: number | null;
  /** Subsequent observed ticks after the prediction was frozen. Legacy rows omit this. */
  futureDigits?: number[];
  /** Frozen estimated ticks for digits 0–9, saved before any future observations. */
  urgencyEstimates?: (number | null)[];
};
const MAX_CHECKS = 3000; // Each row stores ten digit estimates and up to ten future observations.
const storageKey = (symbol: string, pipSize: number) => `dms-next-tick-top5:v2:${symbol}:${pipSize}`;
const escapeCsv = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;

/** Evaluate frozen pre-tick V1 rankings only. No trades are placed here. */
export function NextTickCoverage({ currentTick, pipSize, symbol }: {
  currentTick: Tick | null; pipSize: number; symbol: string;
}) {
  const [checks, setChecks] = useState<Check[]>([]);
  const [ready, setReady] = useState(false);
  const history = useRef<number[]>([]);
  const pending = useRef<{ranked:Frozen[]; estimates:(number|null)[]} | null>(null);
  const lastTickKey = useRef('');
  const scope = useRef('');
  const key = `${symbol}:${pipSize}`;

  useEffect(() => {
    if (scope.current !== key) {
      scope.current = key;
      history.current = [];
      pending.current = null;
      lastTickKey.current = '';
      setReady(false);
      let restored: Check[] = [];
      try {
        const raw = localStorage.getItem(storageKey(symbol, pipSize));
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) restored = parsed.filter((item): item is Check =>
          item && item.symbol === symbol && item.pipSize === pipSize &&
          Number.isInteger(item.actual) && item.actual >= 0 && item.actual <= 9 &&
          Array.isArray(item.predicted) && item.predicted.length === 5 &&
          item.predicted.every((p: Frozen) => Number.isInteger(p.digit) && Number.isFinite(p.score)) &&
          (item.rank === null || (Number.isInteger(item.rank) && item.rank >= 1 && item.rank <= 5)) &&
          (item.urgencyEstimates === undefined || (Array.isArray(item.urgencyEstimates) &&
            item.urgencyEstimates.length === 10 && item.urgencyEstimates.every((n: number|null) => n === null || (Number.isInteger(n) && n >= 1)))) &&
          (item.futureDigits === undefined || (Array.isArray(item.futureDigits) &&
            item.futureDigits.length >= 1 && item.futureDigits.length <= 10 &&
            item.futureDigits.every((d: number) => Number.isInteger(d) && d >= 0 && d <= 9)))
        ).slice(-MAX_CHECKS);
      } catch { /* local storage may be unavailable */ }
      setChecks(restored);
    }
    if (!symbol || !currentTick || !Number.isFinite(currentTick.quote)) return;
    const tickKey = `${currentTick.epoch}:${currentTick.quote}`;
    if (tickKey === lastTickKey.current) return;
    lastTickKey.current = tickKey;
    const actual = getLastDigit(currentTick.quote, pipSize);

    // Evaluate the ranking frozen on the PREVIOUS tick, before using this digit.
    const previous = pending.current;
    if (previous?.ranked.length === 5) {
      const idx = previous.ranked.findIndex(p => p.digit === actual);
      const check: Check = {
        timestamp: Date.now(), symbol, pipSize, tickEpoch: Number(currentTick.epoch),
        actual, predicted: previous.ranked.map(p => ({...p})), rank: idx < 0 ? null : idx + 1,
        urgencyEstimates: [...previous.estimates],
        futureDigits: [actual],
      };
      setChecks(old => {
        // Each previous prediction is evaluated against up to ten *future*
        // observed ticks, without ever changing its frozen ranking.
        const updated = old.map(row => row.futureDigits && row.futureDigits.length < 10
          ? {...row, futureDigits: [...row.futureDigits, actual]}
          : row);
        return [...updated.slice(-(MAX_CHECKS - 1)), check];
      });
    }
    history.current = [...history.current.slice(-99), actual];
    const ranking = scoreDigits(history.current);
    const frozenEstimates = estimateArrivalTicks(history.current);
    pending.current = ranking.length >= 5 ? {
      ranked: ranking.slice(0, 5).map(p => ({digit: p.digit, score: p.score})),
      estimates: Array.from({length:10},(_,digit)=>frozenEstimates[digit] ?? null),
    } : null;
    setReady(pending.current !== null);
  }, [currentTick, key, symbol, pipSize]);

  useEffect(() => {
    if (!symbol || scope.current !== key) return;
    try { localStorage.setItem(storageKey(symbol, pipSize), JSON.stringify(checks)); } catch { /* storage quota or privacy settings */ }
  }, [checks, key, pipSize, symbol]);

  const total = checks.length;
  const hits1 = useMemo(() => checks.filter(x => x.rank === 1).length, [checks]);
  const hits3 = useMemo(() => checks.filter(x => x.rank !== null && x.rank <= 3).length, [checks]);
  const hits5 = useMemo(() => checks.filter(x => x.rank !== null).length, [checks]);
  const latest = checks[checks.length - 1];
  const complete10 = useMemo(() => checks.filter(x => x.futureDigits?.length === 10), [checks]);
  const hitAt = (row: Check, top: number) => row.futureDigits?.findIndex(d =>
    row.predicted.slice(0, top).some(p => p.digit === d)) ?? -1;
  const firstHit1 = (row: Check) => hitAt(row, 1) + 1;
  const firstHit5 = (row: Check) => hitAt(row, 5) + 1;
  const hits10Top1 = complete10.filter(x => firstHit1(x) > 0).length;
  const hits10Top5 = complete10.filter(x => firstHit5(x) > 0).length;
  const completed = complete10.length;
  const pending10 = checks.filter(x => x.futureDigits && x.futureDigits.length < 10).length;
  const pct10 = (n: number) => completed ? `${(100 * n / completed).toFixed(1)}%` : '—';
  const latestComplete = complete10[complete10.length - 1];
  const pct = (n: number) => total ? `${(100 * n / total).toFixed(1)}%` : '—';
  const reset = () => { setChecks([]); try { localStorage.removeItem(storageKey(symbol,pipSize)); } catch {} };
  // Return first future occurrence of a digit. A blank means pending or
  // censored (>10 ticks), never a fabricated 10-tick match.
  const firstAppearance = (row: Check, digit: number): number | null => {
    const ix = row.futureDigits?.indexOf(digit) ?? -1;
    return ix < 0 ? null : ix + 1;
  };
  const exportCsv = () => {
    if (!checks.length) return;
    // One row per frozen prediction; each row has all 10 digits' estimates
    // and observed first arrivals (up to +10 ticks). Never use live estimates
    // to back-fill an earlier snapshot.
    const digitCols = Array.from({length:10},(_,d)=>[
      `digit${d}_estimate_ticks`,`digit${d}_actual_first_tick`,
      `digit${d}_status`,`digit${d}_error_ticks`,
    ]).flat();
    const header = ['timestamp_utc','symbol','pip_size','tick_epoch',
      ...Array.from({length:5},(_,i)=>[`rank${i+1}_digit`,`rank${i+1}_score`]).flat(),
      'actual_next_digit','matched_rank','top1_hit','top3_hit','top5_hit','result',
      'future_ticks_observed','target_first_hit_tick_1to10','top5_first_hit_tick_1to10',
      'top1_within_10','top5_within_10','future_digits_1to10',...digitCols];
    const rows = checks.map(c => {
      const complete = c.futureDigits?.length === 10;
      const extra = Array.from({length:10},(_,digit) => {
        const estimate = c.urgencyEstimates?.[digit] ?? null;
        const observed = firstAppearance(c,digit);
        const status = !c.urgencyEstimates ? 'LEGACY_NO_ESTIMATE'
          : !c.futureDigits ? 'LEGACY_NO_HORIZON'
          : observed !== null ? 'APPEARED'
          : complete ? 'NOT_WITHIN_10' : 'PENDING';
        // Signed error: observed ticks minus estimated ticks. No artificial
        // error for censored/missing digits.
        const error = estimate !== null && observed !== null ? observed-estimate : '';
        return [estimate ?? '',observed ?? '',status,error];
      }).flat();
      return [new Date(c.timestamp).toISOString(),c.symbol,c.pipSize,c.tickEpoch,
        ...c.predicted.flatMap(p=>[p.digit,p.score]),c.actual,c.rank ?? '',
        Number(c.rank === 1),Number(c.rank !== null && c.rank <= 3),Number(c.rank !== null),
        c.rank === null ? 'MISS' : 'HIT', c.futureDigits?.length ?? '',
        c.futureDigits ? (firstHit1(c) || '') : '',
        c.futureDigits ? (firstHit5(c) || '') : '',
        complete ? Number(firstHit1(c)>0) : '',
        complete ? Number(firstHit5(c)>0) : '',
        c.futureDigits?.join(' ') ?? '',...extra];
    });
    const csv = [header.map(escapeCsv).join(','),...rows.map(r=>r.map(escapeCsv).join(','))].join('\r\n');
    const blob = new Blob(['\uFEFF',csv],{type:'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href=url;a.download=`digitmatchstars-v1-top5-${symbol.replace(/[^\w-]/g,'_')}-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  };

  return (
    <section className="mx-3 mt-2 rounded-xl border border-emerald-500/25 bg-[#101a2e] p-3 text-slate-100" aria-label="V1 next-tick prediction coverage">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold text-emerald-300">V1 · Coverage & urgency audit</h3>
        <div className="flex items-center gap-3">
          <button type="button" onClick={exportCsv} disabled={!total} className="rounded border border-emerald-600/50 px-2 py-1 text-[10px] font-bold text-emerald-300 disabled:opacity-40">Export CSV</button>
          <button type="button" onClick={reset} className="text-[10px] text-slate-400 hover:text-white">Reset test</button>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div><div className="text-[10px] text-slate-400">Top 1</div><div className="text-base font-extrabold tabular-nums">{pct(hits1)}</div></div>
        <div><div className="text-[10px] text-slate-400">Top 3</div><div className="text-base font-extrabold tabular-nums">{pct(hits3)}</div></div>
        <div><div className="text-[10px] text-slate-400">Top 5</div><div className="text-base font-extrabold tabular-nums text-emerald-400">{pct(hits5)}</div></div>
      </div>
      <div className="mt-3 border-t border-slate-700/50 pt-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-[11px] font-bold text-emerald-300">Appear within 10 observed ticks</h4>
          <span className="text-[10px] text-slate-400">{completed.toLocaleString()} complete · {pending10} pending</span>
        </div>
        <div className="mt-1 grid grid-cols-2 gap-2">
          <div className="rounded-md bg-[#0b1425] px-2 py-1">
            <div className="text-[10px] text-slate-400">Top digit within 10</div>
            <div className="text-base font-extrabold text-emerald-400">{pct10(hits10Top1)}</div>
          </div>
          <div className="rounded-md bg-[#0b1425] px-2 py-1">
            <div className="text-[10px] text-slate-400">Any Top 5 within 10</div>
            <div className="text-base font-extrabold">{pct10(hits10Top5)}</div>
          </div>
        </div>
        {latestComplete && <p className="mt-1 text-[10px] text-slate-400">
          Last 10-tick test: target {latestComplete.predicted[0].digit} {firstHit1(latestComplete) ? `first appeared at +${firstHit1(latestComplete)}` : 'did not appear'}
          {' · '}Top-5 {firstHit5(latestComplete) ? `hit at +${firstHit5(latestComplete)}` : 'missed'}.
        </p>}
        <p className="mt-1 text-[10px] text-slate-500">Chance benchmarks for independent uniform digits: Top-1 65.1%; any Top-5 99.9%. This measures appearance, not contract wins. Legacy CSV rows are excluded from 10-tick totals.</p>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-700/50 pt-2 text-[11px]">
        <span className="text-slate-400">Evaluated: <strong className="text-white">{total.toLocaleString()}</strong></span>
        <span className={latest?.rank !== null && latest ? 'font-bold text-emerald-400' : 'font-bold text-rose-400'}>
          {latest ? (latest.rank === null ? `MISS · digit ${latest.actual}` : `HIT · digit ${latest.actual} at #${latest.rank}`) : ready ? 'Waiting for next tick' : 'Warming up (10 ticks)'}
        </span>
      </div>
      {latest && <p className="mt-1 text-[10px] text-slate-500">Frozen Top 5: {latest.predicted.map(p=>p.digit).join(' · ')} → next: {latest.actual}</p>}
      <p className="mt-1 text-[10px] text-slate-500">Frozen Top-5 and all 10 urgency estimates included in CSV · observed first arrival marked within +10 ticks · {MAX_CHECKS.toLocaleString()} records retained locally.</p>
    </section>
  );
}
