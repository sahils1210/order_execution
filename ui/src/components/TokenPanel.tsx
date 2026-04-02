import React from 'react';
import type { TokenStatus } from '../types';

interface TokenPanelProps {
  token: TokenStatus;
  onRefresh: () => void;
  refreshing: boolean;
  refreshMsg: { ok: boolean; text: string } | null;
}

export function TokenPanel({ token, onRefresh, refreshing, refreshMsg }: TokenPanelProps) {
  return (
    <div className={`border rounded-lg p-4 ${
      token.valid
        ? 'border-green-800/50 bg-green-950/20'
        : 'border-red-700/60 bg-red-950/30'
    }`}>
      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${token.valid ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`} />
          <span className="text-sm font-medium text-gray-200">Kite Token</span>
          <span className={`text-xs px-2 py-0.5 rounded font-medium ${
            token.valid ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'
          }`}>
            {token.valid ? 'VALID' : 'INVALID'}
          </span>
        </div>

        <button
          onClick={onRefresh}
          disabled={refreshing}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded font-medium transition-colors ${
            refreshing
              ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-700 text-white cursor-pointer'
          }`}
        >
          <svg
            className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {refreshing ? 'Refreshing...' : 'Refresh Token'}
        </button>
      </div>

      {/* Token detail grid */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
        <div>
          <span className="text-gray-500">Last refreshed</span>
          <div className="text-gray-200 mt-0.5">
            {token.lastRefreshedAt ? formatIST(token.lastRefreshedAt) : '—'}
          </div>
        </div>
        <div>
          <span className="text-gray-500">Next auto-refresh</span>
          <div className="text-gray-200 mt-0.5">
            {token.nextRefreshAt ? formatIST(token.nextRefreshAt) : '—'}
            <span className="text-gray-600 ml-1">(08:05 + 09:00 IST verify)</span>
          </div>
        </div>
        <div>
          <span className="text-gray-500">Refreshes this session</span>
          <div className="text-gray-200 mt-0.5">{token.refreshCount}</div>
        </div>
        <div>
          <span className="text-gray-500">Token service</span>
          <div className="text-blue-400 mt-0.5 text-xs truncate">
            token-xdpxv.ondigitalocean.app
          </div>
        </div>
      </div>

      {/* Error banner */}
      {token.lastError && (
        <div className="mt-3 flex items-start gap-2 bg-red-950/50 border border-red-800/50 rounded p-2.5">
          <svg className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div>
            <div className="text-xs font-medium text-red-300 mb-0.5">Token Error</div>
            <div className="text-xs text-red-400 break-all">{token.lastError}</div>
          </div>
        </div>
      )}

      {/* Refresh result message */}
      {refreshMsg && (
        <div className={`mt-3 flex items-center gap-2 rounded p-2 text-xs ${
          refreshMsg.ok
            ? 'bg-green-950/50 border border-green-800/50 text-green-300'
            : 'bg-red-950/50 border border-red-800/50 text-red-300'
        }`}>
          {refreshMsg.ok
            ? <span className="text-green-400">✓</span>
            : <span className="text-red-400">✗</span>
          }
          {refreshMsg.text}
        </div>
      )}
    </div>
  );
}

function formatIST(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
  } catch {
    return iso;
  }
}
