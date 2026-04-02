/**
 * Type declarations for node:sqlite (Node.js 22 experimental built-in)
 * Available with --experimental-sqlite flag
 */
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(location: string, options?: { open?: boolean });
    open(): void;
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }

  export class StatementSync {
    run(...params: (string | number | null | Buffer)[]): {
      changes: number;
      lastInsertRowid: number | bigint;
    };
    get(...params: (string | number | null | Buffer)[]): Record<string, unknown> | undefined;
    all(...params: (string | number | null | Buffer)[]): Record<string, unknown>[];
    iterate(...params: (string | number | null | Buffer)[]): Iterator<Record<string, unknown>>;
  }
}
