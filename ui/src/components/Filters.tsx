import React from 'react';
import type { Filters } from '../types';

interface FiltersProps {
  filters: Filters;
  onChange: (f: Filters) => void;
  onApply: () => void;
  onClear: () => void;
}

export function FilterBar({ filters, onChange, onApply, onClear }: FiltersProps) {
  const set = (key: keyof Filters, val: string) => onChange({ ...filters, [key]: val });

  return (
    <div className="flex flex-wrap items-end gap-3 p-3 bg-gray-900 border border-gray-800 rounded-lg">
      {/* Source */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-gray-500 uppercase tracking-wider">Source</label>
        <select
          value={filters.source}
          onChange={(e) => set('source', e.target.value)}
          className="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
        >
          <option value="">All Sources</option>
          <option value="100-ALGO">100-ALGO</option>
          <option value="ultra-order">ultra-order</option>
        </select>
      </div>

      {/* Status */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-gray-500 uppercase tracking-wider">Status</label>
        <select
          value={filters.status}
          onChange={(e) => set('status', e.target.value)}
          className="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
        >
          <option value="">All Statuses</option>
          <option value="SENT">SENT</option>
          <option value="COMPLETE">COMPLETE</option>
          <option value="ERROR">ERROR</option>
          <option value="REJECTED">REJECTED</option>
          <option value="RECEIVED">RECEIVED</option>
        </select>
      </div>

      {/* From */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-gray-500 uppercase tracking-wider">From</label>
        <input
          type="datetime-local"
          value={filters.from}
          onChange={(e) => set('from', e.target.value)}
          className="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
        />
      </div>

      {/* To */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-gray-500 uppercase tracking-wider">To</label>
        <input
          type="datetime-local"
          value={filters.to}
          onChange={(e) => set('to', e.target.value)}
          className="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
        />
      </div>

      <button
        onClick={onApply}
        className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors"
      >
        Apply
      </button>

      <button
        onClick={onClear}
        className="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded transition-colors"
      >
        Clear
      </button>
    </div>
  );
}
