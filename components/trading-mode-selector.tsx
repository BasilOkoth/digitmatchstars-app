'use client';

import { usePathname, useRouter } from 'next/navigation';

const modes = [
  { label: 'Digit Match', path: '/' },
  { label: 'Accumulator PRO', path: '/accumulator' },
  { label: 'Multipliers PRO', path: '/multipliers' },
] as const;

/** A shared navigation selector. Does not control trading or open positions. */
export function TradingModeSelector() {
  const pathname = usePathname();
  const router = useRouter();
  const selected = pathname?.startsWith('/accumulator')
    ? '/accumulator'
    : pathname?.startsWith('/multipliers')
      ? '/multipliers'
      : '/';

  return (
    <nav aria-label="Trading mode" className="fixed bottom-4 right-4 z-[90] max-w-[calc(100vw-2rem)] rounded-xl border border-cyan-400/40 bg-slate-950/95 p-2 text-white shadow-2xl backdrop-blur-md">
      <label htmlFor="trading-mode-select" className="mb-1 block text-[10px] font-extrabold uppercase tracking-widest text-cyan-300">
        Trading mode
      </label>
      <select
        id="trading-mode-select"
        aria-label="Choose trading mode"
        value={selected}
        onChange={(event) => {
          const next = event.target.value;
          if (next !== selected && modes.some((mode) => mode.path === next)) router.push(next);
        }}
        className="w-44 max-w-full cursor-pointer rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm font-bold text-white outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/40"
      >
        {modes.map((mode) => <option key={mode.path} value={mode.path}>{mode.label}</option>)}
      </select>
    </nav>
  );
}
