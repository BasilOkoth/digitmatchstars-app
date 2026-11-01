'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Tick } from '@deriv/core';
import { getLastDigit } from '@/lib/digit-stats';
import { scoreDigits } from '@/lib/digitmatch-score';

type Frozen = { digit: number; score: number };
type Check = { timestamp: number; symbol: string; pipSize: number; tickEpoch: number; actual: number; predicted: Frozen[]; rank: number | null };
const MAX_CHECKS = 20000;
const storageKey = (symbol: string, pipSize: number) => `dms-next-tick-top5:v2:${symbol}:${pipSize}`;
const escapeCsv = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;

/** Evaluate frozen pre-tick V1 rankings only. No trades are placed here. */
export function NextTickCoverage({ currentTick, pipSize, symbol }: {
  currentTick: Tick | null; pipSize: number; symbol: string;
}) {
  const [checks, setChecks] = useState<Check[]>([]);
  const [ready, setReady] = useState(false);
  const history = useRef<number[]>([]);
  const pending = useRef<Frozen[] | null>(null);
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
          (item.rank === null || (Number.isInteger(item.rank) && item.rank >= 1 && item.rank <= 5))
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
    if (previous?.length === 5) {
      const idx = previous.findIndex(p => p.digit === actual);
      const check: Check = {
        timestamp: Date.now(), symbol, pipSize, tickEpoch: Number(currentTick.epoch),
        actual, predicted: previous.map(p => ({...p})), rank: idx < 0 ? null : idx + 1,
      };
      setChecks(old => [...old.slice(-(MAX_CHECKS - 1)), check]);
    }
    history.current = [...history.current.slice(-99), actual];
    const ranking = scoreDigits(history.current);
    pending.current = ranking.length >= 5 ? ranking.slice(0, 5).map(p => ({digit: p.digit, score: p.score})) : null;
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
  const pct = (n: number) => total ? `${(100 * n / total).toFixed(1)}%` : '—';
  const reset = () => { setChecks([]); try { localStorage.removeItem(storageKey(symbol,pipSize)); } catch {} };
  const exportCsv = () => {
    if (!checks.length) return;
    const header = ['timestamp_utc','symbol','pip_size','tick_epoch',
      ...Array.from({length:5},(_,i)=>[`rank${i+1}_digit`,`rank${i+1}_score`]).flat(),
      'actual_next_digit','matched_rank','top1_hit','top3_hit','top5_hit','result'];
    const rows = checks.map(c => [new Date(c.timestamp).toISOString(),c.symbol,c.pipSize,c.tickEpoch,
      ...c.predicted.flatMap(p=>[p.digit,p.score]),c.actual,c.rank ?? '',
      Number(c.rank === 1),Number(c.rank !== null && c.rank <= 3),Number(c.rank !== null),'',
    ]);
    // Ensure final column is HIT/MISS rather than an empty placeholder.
    const csv = [header.map(escapeCsv).join(','),...rows.map((r,i) => {
      r[r.length-1] = checks[i].rank === null ? 'MISS' : 'HIT';
      return r.map(escapeCsv).join(',');
    })].join('\r\n');
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
        <h3 className="text-xs font-bold text-emerald-300">V1 · Next-tick coverage</h3>
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
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-700/50 pt-2 text-[11px]">
        <span className="text-slate-400">Evaluated: <strong className="text-white">{total.toLocaleString()}</strong></span>
        <span className={latest?.rank !== null && latest ? 'font-bold text-emerald-400' : 'font-bold text-rose-400'}>
          {latest ? (latest.rank === null ? `MISS · digit ${latest.actual}` : `HIT · digit ${latest.actual} at #${latest.rank}`) : ready ? 'Waiting for next tick' : 'Warming up (10 ticks)'}
        </span>
      </div>
      {latest && <p className="mt-1 text-[10px] text-slate-500">Frozen Top 5: {latest.predicted.map(p=>p.digit).join(' · ')} → next: {latest.actual}</p>}
      <p className="mt-1 text-[10px] text-slate-500">Predictions frozen before the next tick · records saved in this browser · last {MAX_CHECKS.toLocaleString()} evaluations retained.</p>
    </section>
  );
}
