import { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import type { OrderLog, OrderUpdateEvent, HealthStatus, Filters, TokenStatus } from '../types';

const API_URL = import.meta.env.VITE_API_URL || '';
const API_KEY = import.meta.env.VITE_GATEWAY_API_KEY || '';

export function useOrders() {
  const [orders, setOrders] = useState<OrderLog[]>([]);
  const [health, setHealth] = useState<HealthStatus>({
    status: 'unknown', kiteConnected: false, uptime: 0, timestamp: '',
    token: { valid: false, lastRefreshedAt: null, nextRefreshAt: null, lastError: null, refreshCount: 0 },
  });
  const [loading, setLoading] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const socketRef = useRef<Socket | null>(null);

  // ── Fetch orders ─────────────────────────────────────────────────────────
  const fetchOrders = useCallback(async (filters: Filters) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.source) params.set('source', filters.source);
      if (filters.status) params.set('status', filters.status);
      if (filters.from)   params.set('from', filters.from);
      if (filters.to)     params.set('to', filters.to);
      params.set('limit', '500');

      const res = await fetch(`${API_URL}/orders?${params}`, {
        headers: { 'X-API-Key': API_KEY },
      });
      const data = await res.json() as { orders?: OrderLog[] };
      setOrders(data.orders ?? []);
    } catch (err) {
      console.error('Failed to fetch orders:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Fetch health ─────────────────────────────────────────────────────────
  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/health`);
      const data = await res.json() as HealthStatus;
      setHealth(data);
    } catch {
      setHealth((h) => ({ ...h, status: 'degraded', kiteConnected: false }));
    }
  }, []);

  // ── Manual token refresh ─────────────────────────────────────────────────
  const refreshToken = useCallback(async () => {
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const res = await fetch(`${API_URL}/refresh-token`, {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY },
      });
      const data = await res.json() as { success: boolean; message: string };
      setRefreshMsg({ ok: data.success, text: data.message });
      await fetchHealth();
    } catch (err) {
      setRefreshMsg({ ok: false, text: `Request failed: ${String(err)}` });
    } finally {
      setRefreshing(false);
      // Clear message after 5 seconds
      setTimeout(() => setRefreshMsg(null), 5000);
    }
  }, [fetchHealth]);

  // ── WebSocket ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = io(API_URL || window.location.origin, {
      transports: ['websocket', 'polling'],
      reconnectionDelay: 1000,
    });
    socketRef.current = socket;

    socket.on('connect', () => setWsConnected(true));
    socket.on('disconnect', () => setWsConnected(false));

    socket.on('order:update', (event: OrderUpdateEvent) => {
      setOrders((prev) => {
        const idx = prev.findIndex((o) => o.idempotencyKey === event.idempotencyKey);
        const newOrder: OrderLog = {
          id: Date.now(),
          idempotencyKey: event.idempotencyKey,
          source: event.source,
          exchange: '',
          tradingsymbol: event.tradingsymbol,
          transactionType: event.transactionType as 'BUY' | 'SELL',
          quantity: event.quantity,
          product: '',
          orderType: '',
          variety: 'regular',
          price: null, triggerPrice: null, tag: null,
          status: event.status as OrderLog['status'],
          kiteOrderId: event.kiteOrderId,
          kiteResponse: null,
          errorMessage: event.errorMessage,
          latencyMs: event.latencyMs,
          receivedAt: event.receivedAt,
          completedAt: null,
        };
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], ...newOrder };
          return updated;
        }
        return [newOrder, ...prev];
      });
    });

    // Real-time token status pushed from server on every refresh/failure
    socket.on('token:status', (status: TokenStatus) => {
      setHealth((h) => ({ ...h, token: status, kiteConnected: status.valid }));
    });

    return () => { socket.disconnect(); };
  }, []);

  // ── Health polling every 15s ──────────────────────────────────────────────
  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 15_000);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  return { orders, health, loading, wsConnected, fetchOrders, refreshToken, refreshing, refreshMsg };
}
