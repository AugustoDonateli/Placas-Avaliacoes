/**
 * Um D1 de verdade para os testes, sobre o `node:sqlite` embutido no Node.
 *
 * Por que nao um duble: os testes da API precisam exercitar o banco REAL —
 * os CHECK da tabela, a restricao UNIQUE e principalmente o trigger de
 * `updated_at`. Um duble em memoria testaria o nosso codigo contra a nossa
 * propria imaginacao do que o SQLite faz.
 *
 * A migration carregada e o mesmo arquivo que roda em producao.
 */

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const MIGRATION = fileURLToPath(
  new URL('../../migrations/0001_create_plates.sql', import.meta.url),
);

type Row = Record<string, unknown>;

/** Converte os `?1`, `?2` do D1 para os `?` posicionais do node:sqlite. */
function toPositional(sql: string): string {
  return sql.replace(/\?\d+/g, '?');
}

export interface TestDb {
  readonly d1: D1Database;
  /** Atalho para montar estado no arranjo do teste. */
  exec(sql: string, ...values: unknown[]): void;
  query<T = Row>(sql: string, ...values: unknown[]): T[];
  close(): void;
}

export function createTestDb(): TestDb {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(MIGRATION, 'utf8'));

  function prepare(sql: string) {
    const positional = toPositional(sql);
    let bound: unknown[] = [];

    const statement = {
      bind(...values: unknown[]) {
        bound = values;
        return statement;
      },
      async first<T>(): Promise<T | null> {
        const row = sqlite.prepare(positional).get(...(bound as never[]));
        return (row as T | undefined) ?? null;
      },
      async all<T>(): Promise<{ results: T[]; success: true }> {
        const rows = sqlite.prepare(positional).all(...(bound as never[]));
        return { results: rows as T[], success: true };
      },
      async run(): Promise<{ success: true }> {
        sqlite.prepare(positional).run(...(bound as never[]));
        return { success: true };
      },
      /** Usado pelo shim de batch. */
      __apply(): void {
        sqlite.prepare(positional).run(...(bound as never[]));
      },
    };

    return statement;
  }

  const d1 = {
    prepare,
    async batch(statements: Array<{ __apply(): void }>) {
      // O D1 roda o lote numa transacao; reproduzimos isso para que um lote
      // que falha no meio nao deixe placas criadas pela metade.
      sqlite.exec('BEGIN');
      try {
        for (const statement of statements) statement.__apply();
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
      return statements.map(() => ({ success: true }));
    },
  } as unknown as D1Database;

  return {
    d1,
    exec(sql: string, ...values: unknown[]) {
      sqlite.prepare(toPositional(sql)).run(...(values as never[]));
    },
    query<T = Row>(sql: string, ...values: unknown[]): T[] {
      return sqlite.prepare(toPositional(sql)).all(...(values as never[])) as T[];
    },
    close() {
      sqlite.close();
    },
  };
}
