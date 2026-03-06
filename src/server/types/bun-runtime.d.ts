declare module 'bun:sqlite' {
  export class Database {
    constructor(filename: string, options?: unknown)
    close(): void
    exec(sql: string): void
    query<T = unknown>(sql: string): {
      get(...params: unknown[]): T | null
      all(...params: unknown[]): T[]
      run(...params: unknown[]): { lastInsertRowid?: number | bigint; changes?: number }
    }
  }
}

interface ImportMeta {
  readonly dir: string
}
