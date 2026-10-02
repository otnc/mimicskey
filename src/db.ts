import Database from "better-sqlite3";

export type NoteRow = {
  id: string;
  userId: string;
  text: string;
  createdAt: string | null;
};

// 学習済みノート (notes) と、同期カーソルや最終投稿時刻といった状態 (state) を SQLite に保存する。better-sqlite3 は同期 API なので、バックフィルの書き込みはトランザクションにまとめて 1 度にコミットする。
export const createStore = (path: string) => {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const insertStmt = db.prepare(
    "INSERT OR IGNORE INTO notes (id, user_id, text, created_at) VALUES (?, ?, ?, ?)",
  );

  // 重複は INSERT OR IGNORE で吸収し、戻り値は新規に追加された行数だけ。
  const upsertNotes = (rows: NoteRow[]) => {
    if (rows.length === 0) return 0;
    const insertAll = db.transaction((rs: NoteRow[]) => {
      let inserted = 0;
      for (const row of rs) {
        inserted += insertStmt.run(row.id, row.userId, row.text, row.createdAt).changes;
      }
      return inserted;
    });
    return insertAll(rows);
  };

  const getState = (key: string) => {
    const row = db.prepare("SELECT value FROM state WHERE key = ?").get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  };

  const setState = (key: string, value: string) => {
    db.prepare(
      "INSERT INTO state (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  };

  const deleteState = (key: string) => {
    db.prepare("DELETE FROM state WHERE key = ?").run(key);
  };

  // 新しい順に本文を返す。チェーンの再構築に使う。
  const loadRecentTexts = (limit: number) =>
    (
      db.prepare("SELECT text FROM notes ORDER BY created_at DESC LIMIT ?").all(limit) as {
        text: string;
      }[]
    ).map((r) => r.text);

  const countNotes = () => {
    const row = db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number };
    return row.c;
  };

  // 学習設定変更時に呼ぶ: ノートと同期カーソル、途中までのバックフィルの進捗をすべて削除する。
  // uid:* (ユーザー ID キャッシュ) と lastPostAt は残す。
  const clearLearningData = () => {
    db.exec("DELETE FROM notes");
    db.prepare("DELETE FROM state WHERE key LIKE 'cursor:%' OR key LIKE 'backfill:%'").run();
  };

  return {
    upsertNotes,
    getState,
    setState,
    deleteState,
    loadRecentTexts,
    countNotes,
    clearLearningData,
    close: () => db.close(),
  };
};

export type Store = ReturnType<typeof createStore>;
