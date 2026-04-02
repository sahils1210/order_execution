import React from 'react';
import { StatusBadge } from './StatusBadge';
import type { OrderLog } from '../types';

interface OrderTableProps {
  orders: OrderLog[];
  loading: boolean;
}

export function OrderTable({ orders, loading }: OrderTableProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          Loading orders...
        </div>
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-600">
        No orders found
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-gray-800 text-left">
            <th className="px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium">Time</th>
            <th className="px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium">Source</th>
            <th className="px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium">Symbol</th>
            <th className="px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium">Side</th>
            <th className="px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium">Qty</th>
            <th className="px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium">Type</th>
            <th className="px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium">Status</th>
            <th className="px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium">Kite ID</th>
            <th className="px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium">Latency</th>
            <th className="px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium">Error</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <OrderRow key={order.idempotencyKey} order={order} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OrderRow({ order }: { order: OrderLog }) {
  const time = formatTime(order.receivedAt);
  const isError = order.status === 'ERROR' || order.status === 'REJECTED';

  return (
    <tr
      className={`border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors ${
        isError ? 'bg-red-950/20' : ''
      }`}
    >
      <td className="px-3 py-2 text-gray-400 text-xs whitespace-nowrap">{time}</td>

      <td className="px-3 py-2">
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded ${
            order.source === '100-ALGO'
              ? 'bg-purple-900/50 text-purple-300'
              : order.source === 'ultra-order'
              ? 'bg-cyan-900/50 text-cyan-300'
              : 'bg-gray-700 text-gray-400'
          }`}
        >
          {order.source}
        </span>
      </td>

      <td className="px-3 py-2 text-gray-100 font-medium">{order.tradingsymbol}</td>

      <td className="px-3 py-2">
        <span
          className={`text-xs font-semibold ${
            order.transactionType === 'BUY' ? 'text-green-400' : 'text-red-400'
          }`}
        >
          {order.transactionType}
        </span>
      </td>

      <td className="px-3 py-2 text-gray-200">{order.quantity}</td>

      <td className="px-3 py-2 text-gray-400 text-xs">{order.orderType}</td>

      <td className="px-3 py-2">
        <StatusBadge status={order.status} />
      </td>

      <td className="px-3 py-2 text-gray-400 text-xs font-mono">
        {order.kiteOrderId ? (
          <span className="text-blue-400">{order.kiteOrderId}</span>
        ) : (
          <span className="text-gray-700">—</span>
        )}
      </td>

      <td className="px-3 py-2 text-xs">
        <LatencyBadge ms={order.latencyMs} />
      </td>

      <td className="px-3 py-2 text-xs text-red-400 max-w-xs truncate">
        {order.errorMessage || <span className="text-gray-700">—</span>}
      </td>
    </tr>
  );
}

function LatencyBadge({ ms }: { ms: number }) {
  if (!ms) return <span className="text-gray-700">—</span>;
  const color = ms < 100 ? 'text-green-400' : ms < 300 ? 'text-yellow-400' : 'text-red-400';
  return <span className={color}>{ms}ms</span>;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return iso;
  }
}
