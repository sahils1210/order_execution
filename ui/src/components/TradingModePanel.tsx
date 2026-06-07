import React, { useState } from 'react';
import type { TradingModeStatus, TradingMode } from '../types';

interface Props {
  mode: TradingModeStatus | null;
  changing: boolean;
  onChange: (next: TradingMode, reason: string) => Promise<{ ok: boolean; message?: string }>;
}

/**
 * Trading mode panel (Design B binary toggle).
 *
 * Shows the effective state prominently (big LIVE green pill or DRY-RUN
 * yellow pill) and exposes a toggle to switch.
 *
 * Safety:
 *   - Switching TO 'live' ALWAYS opens a confirmation dialog. This is the
 *     direction that creates real-money exposure; we make the operator
 *     explicitly confirm intent.
 *   - Switching TO 'dry-run' is one-click (no confirm) — only adds safety.
 *   - When market is OPEN and operator is switching to dry-run, we still
 *     show a short warning ("you're suppressing live trading right now")
 *     but don't block.
 */
export function TradingModePanel({ mode, changing, onChange }: Props) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [pendingReason, setPendingReason] = useState('');

  if (!mode) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
        <div className="text-xs text-gray-500 uppercase tracking-wider">Trading Mode</div>
        <div className="text-sm text-gray-600 mt-1">Loading…</div>
      </div>
    );
  }

  const isDry = mode.effectiveActive;
  const operatorSet = mode.mode === 'dry-run';
  const envSet = !operatorSet && mode.envFlag && !mode.marketOpen;

  const handleToggleClick = () => {
    if (mode.mode === 'live') {
      // Switching to dry-run — no confirm (only adds safety)
      void onChange('dry-run', `UI toggle ${mode.marketOpen ? '(market OPEN)' : '(market closed)'}`);
    } else {
      // Switching to live — confirm
      setPendingReason('');
      setShowConfirm(true);
    }
  };

  const confirmSwitchToLive = async () => {
    const reason = pendingReason.trim() || 'UI toggle (operator confirmed)';
    const result = await onChange('live', reason);
    if (result.ok) setShowConfirm(false);
  };

  return (
    <div className={`border rounded-lg p-3 ${isDry ? 'border-yellow-700/60 bg-yellow-950/30' : 'border-green-800/40 bg-green-950/20'}`}>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wider">Trading Mode</div>
          <div className="flex items-center gap-2 mt-1">
            <span className={`text-xl font-bold ${isDry ? 'text-yellow-300' : 'text-green-300'}`}>
              {isDry ? '🧪 DRY-RUN' : '🔴 LIVE'}
            </span>
            {operatorSet && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-yellow-800/40 text-yellow-200">
                operator override
              </span>
            )}
            {envSet && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-700/60 text-gray-300">
                env + market closed
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {isDry
              ? 'Orders are SIMULATED. No Kite calls. No real exposure.'
              : `Orders go to Kite live. ${mode.marketOpen ? 'Market is OPEN.' : 'Market is closed (Kite may reject most order types).'}`}
          </div>
          {mode.reason && (
            <div className="text-xs text-gray-600 mt-1">
              Last change: <span className="text-gray-400">{mode.reason}</span> by{' '}
              <span className="text-gray-400">{mode.source ?? '?'}</span>
            </div>
          )}
        </div>

        <button
          onClick={handleToggleClick}
          disabled={changing}
          className={`px-3 py-1.5 rounded text-xs font-medium ${
            mode.mode === 'live'
              ? 'bg-yellow-700 hover:bg-yellow-600 text-yellow-100'
              : 'bg-green-700 hover:bg-green-600 text-green-100'
          } disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {changing ? 'Switching…' : (mode.mode === 'live' ? 'Switch to DRY-RUN' : 'Switch to LIVE')}
        </button>
      </div>

      {showConfirm && (
        <div className="mt-3 border border-red-700 bg-red-950/40 rounded p-3">
          <div className="text-sm font-medium text-red-200 mb-2">
            ⚠️ Confirm switch to LIVE
          </div>
          <div className="text-xs text-red-300 mb-3">
            All subsequent orders will be sent to Kite as REAL trades. Position state and PnL will be affected.
            {mode.marketOpen && ' Market is currently OPEN — orders may fill immediately.'}
          </div>
          <input
            type="text"
            value={pendingReason}
            onChange={(e) => setPendingReason(e.target.value)}
            placeholder="Reason (optional, audited)"
            className="w-full px-2 py-1 text-xs bg-gray-900 border border-gray-700 rounded text-gray-200 mb-2"
          />
          <div className="flex gap-2">
            <button
              onClick={confirmSwitchToLive}
              disabled={changing}
              className="px-3 py-1.5 rounded text-xs font-medium bg-red-700 hover:bg-red-600 text-white disabled:opacity-50"
            >
              {changing ? 'Switching…' : 'Confirm LIVE'}
            </button>
            <button
              onClick={() => setShowConfirm(false)}
              disabled={changing}
              className="px-3 py-1.5 rounded text-xs font-medium bg-gray-700 hover:bg-gray-600 text-gray-200 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
