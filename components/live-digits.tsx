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
import { IntelligencePanel } from './intelligence-panel';
import { DemoTradeAssistant } from './demo-trade-assistant';
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
    <div className="dark min-h-screen bg-[#090e1b] text-slate-100">
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
    {!editMode && (
      <DemoTradeAssistant
        accountType={activeAccount?.account_type}
        accountId={activeAccount?.account_id}
        symbol={trading.activeSymbol?.underlying_symbol ?? ''}
        proposalPrice={trading.proposal?.askPrice ?? null}
        isConnected={trading.isConnected}
        isBuying={trading.isBuying}
        buyContract={trading.buyContract}
        buyError={trading.buyError}
        closedPositions={trading.closedPositions}
        contractMode={trading.contractMode}
        stake={trading.stake}
        duration={trading.duration}
      />
    )}
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
    </div>
  );
}
