// =========================================
// DEPRECATED — superseded by DB-only idempotency.
//
// Idempotency is now handled atomically by `atomicCheckAndInsert` in db/database.ts
// and the OrderManager state machine. Keeping this file empty so accidental
// imports fail fast.
// =========================================

export {};
