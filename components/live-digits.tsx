'use client';

/**
 * The real, functional Digits app (live WebSocket, real auth/trading), rendered
 * via DigitsView. Optionally takes a no-code `appConfig` to render the
 * configurable control styles/order. Shared by the deployed page and the editor
 * (/edit) so the editor preview is fully live.
 */

import { useDigitsTrading } from '../hooks/use-digits-trading';
import { useDerivWSContext } from '@/components/custom/deriv-ws-provider';
import { useLogoSrc } from '@/components/custom/logo-src-provider';
import { DigitsView } from './digits-view';
import { DigitScoreProvider } from './digit-stats-bar';
import { IntegratedBot } from './integrated-bot';
import { NextTickCoverage } from './next-tick-coverage';
import { IntelligencePanel } from './intelligence-panel';
import type { DigitsAppConfig } from '../lib/app-config';

export function LiveDigits({
  appConfig,
  editMode,
  onSelect,
  selectedKey,
  rearrangeMode,
  onReorder,
  logoSrc: logoSrcOverride,
  appName,
  showAppName,
}: {
  appConfig?: DigitsAppConfig;
  editMode?: boolean;
  onSelect?: (key: string) => void;
  selectedKey?: string | null;
  rearrangeMode?: boolean;
  onReorder?: (order: DigitsAppConfig['order']) => void;
  /** Override the provider logo — used by the editor to show the previewed logo. */
  logoSrc?: string;
  appName?: string;
  showAppName?: boolean;
}) {
  const providerLogo = useLogoSrc();
  const logoSrc = logoSrcOverride ?? providerLogo;
  const { ws, isConnected, isExhausted, auth } = useDerivWSContext();
  const { authState, accounts, activeAccount, login, signUp, logout, switchAccount } = auth;

  const trading = useDigitsTrading({
    ws,
    isConnected,
    isExhausted,
    isAuthenticated: !!auth.wsUrl,
    onAuthWSFailed: logout,
  });

  return (
    <DigitScoreProvider tick={trading.currentTick} pipSize={trading.pipSize} symbol={trading.activeSymbol?.underlying_symbol ?? ''}>
    <>
    <div className="mx-auto grid w-full max-w-[1500px] grid-cols-1 items-start gap-2 px-2 pt-2 xl:grid-cols-[minmax(0,1fr)_minmax(390px,0.8fr)] xl:gap-3 xl:px-4">
      <div className="min-w-0">
    <DigitsView
      authState={authState}
      accounts={accounts}
      activeAccount={activeAccount}
      onLogin={login}
      onSignUp={signUp}
      onLogout={logout}
      onSwitchAccount={switchAccount}
      logoSrc={logoSrc}
      appName={appName}
      showAppName={showAppName}
      isConnected={trading.isConnected}
      isLoading={trading.isLoading}
      error={trading.error}
      symbols={trading.symbols}
      activeSymbol={trading.activeSymbol}
      selectSymbol={trading.selectSymbol}
      currentTick={trading.currentTick}
      lastDigit={trading.lastDigit}
      digitStats={trading.digitStats}
      pipSize={trading.pipSize}
      tradeType={trading.tradeType}
      setTradeType={trading.setTradeType}
      contractMode={trading.contractMode}
      setContractMode={trading.setContractMode}
      selectedDigit={trading.selectedDigit}
      setSelectedDigit={trading.setSelectedDigit}
      stake={trading.stake}
      setStake={trading.setStake}
      duration={trading.duration}
      setDuration={trading.setDuration}
      durationLimits={trading.durationLimits}
      proposal={trading.proposal}
      isProposalLoading={trading.isProposalLoading}
      buyContract={trading.buyContract}
      isBuying={trading.isBuying}
      buyResult={trading.buyResult}
      buyError={trading.buyError}
      clearBuyResult={trading.clearBuyResult}
      appConfig={appConfig}
      editMode={editMode}
      onSelect={onSelect}
      selectedKey={selectedKey}
      rearrangeMode={rearrangeMode}
      onReorder={onReorder}
    />
      </div>
    {!editMode && <div className="min-w-0 lg:sticky lg:top-2"><IntegratedBot ws={ws} accountId={activeAccount?.account_id ?? null} accountType={activeAccount?.account_type ?? null} isConnected={trading.isConnected} currentTick={trading.currentTick} pipSize={trading.pipSize} symbol={trading.activeSymbol?.underlying_symbol ?? ''} /><NextTickCoverage currentTick={trading.currentTick} pipSize={trading.pipSize} symbol={trading.activeSymbol?.underlying_symbol ?? ''} /></div>}
    </div>
    {!editMode && (
      <IntelligencePanel
        currentTick={trading.currentTick}
        pipSize={trading.pipSize}
        selectedDigit={trading.selectedDigit}
        symbol={trading.activeSymbol?.underlying_symbol ?? ''}
        digitStats={trading.digitStats}
        proposal={trading.proposal}
        closedPositions={trading.closedPositions}
        accountKey={activeAccount?.account_id ?? 'guest'}
      />
    )}
    </>
    </DigitScoreProvider>
  );
}
