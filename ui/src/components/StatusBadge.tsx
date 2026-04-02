import React from 'react';
import type { OrderStatus } from '../types';

const styles: Record<string, string> = {
  RECEIVED:  'bg-gray-700 text-gray-300',
  IN_FLIGHT: 'bg-yellow-900 text-yellow-300 animate-pulse',
  SENT:      'bg-blue-900 text-blue-300',
  COMPLETE:  'bg-green-900 text-green-300',
  REJECTED:  'bg-red-900 text-red-300',
  ERROR:     'bg-red-900 text-red-400',
};

export function StatusBadge({ status }: { status: OrderStatus | string }) {
  const cls = styles[status] ?? 'bg-gray-700 text-gray-400';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}
