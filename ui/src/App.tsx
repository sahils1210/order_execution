import React, { useState, useEffect } from 'react';
import { OrderTable } from './components/OrderTable';
import { FilterBar } from './components/Filters';
import { TokenPanel } from './components/TokenPanel';
import { useOrders } from './hooks/useOrders';
import type { Filters } from './types';

function App() {
  const { orders, health, loading, wsConnected, fetchOrders, refreshToken, refreshing, refreshMsg } = useOrders();

  const [filters, setFilters] = useState<Filters>({ source: '', status: '', from: '', to: '' });

  useEffect(() => {
    fetchOrders(filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleApply = () => fetchOrders(filters);

  const totalToday = orders.length;
  const sentCount   = orders.filter((o) => o.status === 'SENT' || o.status === 'COMPLETE').length;
  const errorCount  = orders.filter((o) => o.status === 'ERROR' || o.status === 'REJECTED').length;
  const avgLatency  = orders.length > 0
    ? Math.round(orders.reduce((s, o) => s + (o.latencyMs || 0), 0) / orders.length)
    : 0;

  const isDown = health.status === 'degraded' || (!health.kiteConnected && health.status !== 'unknown');

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-mono">

      {/* ── Critical alert banner — shown when Kite is disconnected ── */}
      {isDown && (
        <div className="bg-red-900/80 border-b border-red-700 px-6 py-2.5 flex items-center gap-3">
          <svg className="w-4 h-4 text-red-300 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="text-sm text-red-200 font-medium">
            Kite API disconnected — orders will fail until token is refreshed.
          </span>
          {health.token?.lastError && (
            <span className="text-xs text-red-300 truncate max-w-md">
              {health.token.lastError}
            </span>
          )}
          <button
            onClick={refreshToken}
            disabled={refreshing}
            className="ml-auto text-xs bg-red-700 hover:bg-red-600 text-white px-3 py-1 rounded flex-shrink-0"
          >
            {refreshing ? 'Refreshing...' : 'Fix Now'}
          </button>
        </div>
      )}

      {/* ── Header ── */}
      <header className="border-b border-gray-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-blue-500" />
          <h1 className="text-base font-semibold text-white tracking-wide">ORDER GATEWAY</h1>
          <span className="text-xs text-gray-600">v1.0.0</span>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-xs">
            <div className={`w-1.5 h-1.5 rounded-full ${wsConnected ? 'bg-green-500 animate-pulse' : 'bg-gray-600'}`} />
            <span className={wsConnected ? 'text-green-400' : 'text-gray-500'}>
              {wsConnected ? 'Live' : 'Disconnected'}
            </span>
          </div>

          <div className="flex items-center gap-1.5 text-xs">
            <div className={`w-1.5 h-1.5 rounded-full ${health.kiteConnected ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className={health.kiteConnected ? 'text-green-400' : 'text-red-400'}>
              Kite {health.kiteConnected ? 'OK' : 'DOWN'}
            </span>
          </div>

          {health.uptime > 0 && (
            <span className="text-xs text-gray-600">Up {formatUptime(health.uptime)}</span>
          )}
        </div>
      </header>

      <main className="p-6 space-y-4">

        {/* ── Token Status Panel ── */}
        <TokenPanel
          token={health.token ?? { valid: false, lastRefreshedAt: null, nextRefreshAt: null, lastError: null, refreshCount: 0 }}
          onRefresh={refreshToken}
          refreshing={refreshing}
          refreshMsg={refreshMsg}
        />

        {/* ── Stats Row ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Total Orders"  value={totalToday} color="text-white" />
          <StatCard label="Successful"    value={sentCount}  color="text-green-400" />
          <StatCard label="Failed"        value={errorCount} color={errorCount > 0 ? 'text-red-400' : 'text-gray-500'} />
          <StatCard
            label="Avg Latency"
            value={avgLatency > 0 ? `${avgLatency}ms` : '—'}
            color={avgLatency === 0 ? 'text-gray-500' : avgLatency < 100 ? 'text-green-400' : avgLatency < 300 ? 'text-yellow-400' : 'text-red-400'}
          />
        </div>

        {/* ── Source breakdown ── */}
        <div className="grid grid-cols-2 gap-3">
          <SourceCard
            label="100-ALGO"
            count={orders.filter((o) => o.source === '100-ALGO').length}
            errors={orders.filter((o) => o.source === '100-ALGO' && (o.status === 'ERROR' || o.status === 'REJECTED')).length}
            color="purple"
          />
          <SourceCard
            label="ultra-order"
            count={orders.filter((o) => o.source === 'ultra-order').length}
            errors={orders.filter((o) => o.source === 'ultra-order' && (o.status === 'ERROR' || o.status === 'REJECTED')).length}
            color="cyan"
          />
        </div>

        {/* ── Filters ── */}
        <FilterBar filters={filters} onChange={setFilters} onApply={handleApply} />

        {/* ── Order Table ── */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-800 flex items-center justify-between">
            <span className="text-xs text-gray-500 uppercase tracking-wider">Order Log</span>
            <span className="text-xs text-gray-600">{orders.length} records</span>
          </div>
          <OrderTable orders={orders} loading={loading} />
        </div>
      </main>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
      <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function SourceCard({ label, count, errors, color }: { label: string; count: number; errors: number; color: 'purple' | 'cyan' }) {
  const cls = color === 'purple' ? 'border-purple-800/50 bg-purple-950/20' : 'border-cyan-800/50 bg-cyan-950/20';
  const textCls = color === 'purple' ? 'text-purple-300' : 'text-cyan-300';
  return (
    <div className={`border rounded-lg p-3 ${cls}`}>
      <div className={`text-sm font-medium mb-1 ${textCls}`}>{label}</div>
      <div className="flex items-end gap-4">
        <div>
          <span className="text-xl font-semibold text-white">{count}</span>
          <span className="text-xs text-gray-500 ml-1">orders</span>
        </div>
        {errors > 0 && (
          <div>
            <span className="text-sm font-medium text-red-400">{errors}</span>
            <span className="text-xs text-gray-500 ml-1">failed</span>
          </div>
        )}
      </div>
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export default App;
