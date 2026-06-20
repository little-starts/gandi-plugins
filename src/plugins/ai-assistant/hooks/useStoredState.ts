import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

type StoredStateOptions<T> = {
  prepareForStorage?: (value: T) => unknown;
  getFallbackStorageValue?: (value: T, error: unknown) => unknown;
  debounceMs?: number;
};

const isQuotaExceededError = (error: unknown) => {
  const value = error as { name?: string; code?: number } | null;
  return value?.name === "QuotaExceededError" || value?.name === "NS_ERROR_DOM_QUOTA_REACHED" || value?.code === 22;
};

const readStoredValue = <T>(key: string, defaultValue: T): T => {
  try {
    const storedValue = localStorage.getItem(key);
    if (!storedValue) {
      return defaultValue;
    }
    return JSON.parse(storedValue) as T;
  } catch {
    return defaultValue;
  }
};

export function useStoredState<T>(
  key: string,
  defaultValue: T,
  options?: StoredStateOptions<T>,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readStoredValue(key, defaultValue));

  useEffect(() => {
    const saveValue = (nextValue: unknown) => {
      localStorage.setItem(key, JSON.stringify(nextValue));
    };

    const persist = () => {
      try {
        saveValue(options?.prepareForStorage ? options.prepareForStorage(value) : value);
      } catch (error) {
        if (isQuotaExceededError(error) && options?.getFallbackStorageValue) {
          try {
            saveValue(options.getFallbackStorageValue(value, error));
            console.warn(`[AI Assistant] Storage quota exceeded for ${key}; saved a reduced payload instead.`);
            return;
          } catch (fallbackError) {
            console.warn(`[AI Assistant] Failed to save reduced payload for ${key}.`, fallbackError);
            return;
          }
        }

        console.warn(`[AI Assistant] Failed to persist ${key}.`, error);
      }
    };

    const debounceMs = Math.max(0, options?.debounceMs || 0);
    if (!debounceMs) {
      persist();
      return;
    }

    const timeout = window.setTimeout(persist, debounceMs);
    return () => window.clearTimeout(timeout);
  }, [key, options, value]);

  return [value, setValue];
}
