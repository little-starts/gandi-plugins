import { Dispatch, SetStateAction, useCallback, useEffect, useRef, useState } from "react";

const STORAGE_INFO_CHANGE_EVENT = "storage-info-change";

const readStorageValue = <T>(key: string, defaultValue: T) => {
  const storageValue = localStorage.getItem(key);
  if (!storageValue) {
    return defaultValue;
  }

  try {
    return JSON.parse(storageValue) as T;
  } catch {
    return defaultValue;
  }
};

function useStorageInfo<T>(key: string, defaultValue: T) {
  const defaultValueRef = useRef(defaultValue);
  defaultValueRef.current = defaultValue;
  const [value, setValueState] = useState<T>(() => readStorageValue(key, defaultValue));

  useEffect(() => {
    setValueState(readStorageValue(key, defaultValueRef.current));
  }, [key]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key && event.key !== key) {
        return;
      }

      setValueState(readStorageValue(key, defaultValueRef.current));
    };

    const handleStorageInfoChange = (event: Event) => {
      const customEvent = event as CustomEvent<{ key: string; value: T }>;
      if (customEvent.detail?.key !== key) {
        return;
      }

      setValueState(customEvent.detail.value);
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(STORAGE_INFO_CHANGE_EVENT, handleStorageInfoChange);

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(STORAGE_INFO_CHANGE_EVENT, handleStorageInfoChange);
    };
  }, [key]);

  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (data) => {
      setValueState((previousValue) => {
        const nextValue = typeof data === "function" ? (data as (prevState: T) => T)(previousValue) : data;

        localStorage.setItem(key, JSON.stringify(nextValue));
        window.dispatchEvent(
          new CustomEvent(STORAGE_INFO_CHANGE_EVENT, {
            detail: {
              key,
              value: nextValue,
            },
          }),
        );

        return nextValue;
      });
    },
    [key],
  );

  return [value, setValue] as const;
}

export default useStorageInfo;
