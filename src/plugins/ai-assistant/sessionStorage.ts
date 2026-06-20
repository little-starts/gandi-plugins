import { ChatSession } from "./types";

const DB_NAME = "AI_ASSISTANT_CHAT_SESSIONS";
const DB_VERSION = 1;
const SESSION_STORE = "sessions";
const LEGACY_SESSIONS_KEY = "AI_ASSISTANT_SESSIONS";

const requestToPromise = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const transactionDone = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
  });

const openSessionDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const readLegacySessions = (): ChatSession[] => {
  try {
    const raw = localStorage.getItem(LEGACY_SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn("[AI Assistant] Failed to read legacy chat sessions.", error);
    return [];
  }
};

export const loadPersistedChatSessions = async (): Promise<ChatSession[]> => {
  let db: IDBDatabase | null = null;
  try {
    db = await openSessionDb();
    const transaction = db.transaction(SESSION_STORE, "readonly");
    const store = transaction.objectStore(SESSION_STORE);
    const sessions = await requestToPromise<ChatSession[]>(store.getAll());
    await transactionDone(transaction);

    if (sessions.length > 0) {
      return sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }

    const legacySessions = readLegacySessions();
    if (legacySessions.length > 0) {
      await savePersistedChatSessions(legacySessions);
      return legacySessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }

    return [];
  } finally {
    db?.close();
  }
};

export const savePersistedChatSessions = async (sessions: ChatSession[]) => {
  let db: IDBDatabase | null = null;
  try {
    db = await openSessionDb();
    const transaction = db.transaction(SESSION_STORE, "readwrite");
    const store = transaction.objectStore(SESSION_STORE);
    const existingKeys = await requestToPromise<IDBValidKey[]>(store.getAllKeys());
    const nextIds = new Set(sessions.map((session) => session.id));

    existingKeys.forEach((key) => {
      if (!nextIds.has(String(key))) {
        store.delete(key);
      }
    });
    sessions.forEach((session) => store.put(session));

    await transactionDone(transaction);
  } finally {
    db?.close();
  }
};
