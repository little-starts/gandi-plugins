import { useCallback } from "react";
import { UserGuide } from "../types";
import { createUserGuideId, normalizeGuideName, normalizeUserGuide } from "../guideRegistry";
import { useStoredState } from "./useStoredState";

const STORAGE_KEY = "ai-assistant-user-guides";

const readTextFile = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsText(file);
  });

const readArrayBuffer = (file: File) =>
  new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsArrayBuffer(file);
  });

const readZipEntries = async (file: File) => {
  const buffer = await readArrayBuffer(file);
  const view = new DataView(buffer);
  const decoder = new TextDecoder("utf-8");
  const entries: Record<string, string> = {};
  let offset = 0;

  while (offset + 30 <= view.byteLength) {
    const signature = view.getUint32(offset, true);
    if (signature !== 0x04034b50) break;
    const compression = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    const name = decoder.decode(new Uint8Array(buffer, nameStart, nameLength)).replace(/\\/g, "/");

    if (!name.endsWith("/")) {
      if (compression !== 0) {
        throw new Error("暂不支持压缩过的 zip，请导入使用 store 方式打包的 zip。 ");
      }
      entries[name] = decoder.decode(new Uint8Array(buffer, dataStart, uncompressedSize));
    }

    offset = dataEnd;
  }

  return entries;
};

const guideNameFromFile = (fileName: string) => fileName.replace(/\.(md|zip)$/i, "");

export const useGuides = () => {
  const [userGuides, setUserGuides] = useStoredState<UserGuide[]>(STORAGE_KEY, []);

  const saveGuide = useCallback(
    (guide: Partial<UserGuide>) => {
      const normalized = normalizeUserGuide({
        id: guide.id || createUserGuideId(),
        name: guide.name || guide.title || "guide",
        title: guide.title || guide.name || "Guide",
        content: guide.content || "# Guide\n",
        description: guide.description || "",
        category: guide.category || "read",
        createdBy: guide.createdBy || "user",
        enabled: guide.enabled !== false,
        createdAt: guide.createdAt || Date.now(),
        updatedAt: Date.now(),
        indexJs: guide.indexJs,
      });
      setUserGuides((previous) => {
        const existingIndex = previous.findIndex((item) => item.id === normalized.id);
        if (existingIndex < 0) return [...previous, normalized];
        return previous.map((item, index) =>
          index === existingIndex ? { ...normalized, createdAt: item.createdAt } : item,
        );
      });
      return normalized;
    },
    [setUserGuides],
  );

  const createAiGuide = useCallback(
    (guide: Partial<UserGuide>) => {
      const normalizedName = normalizeGuideName(guide.name || guide.title || "ai-guide");
      const now = Date.now();
      const normalized = normalizeUserGuide({
        id:
          guide.id ||
          userGuides.find(
            (item) =>
              (item.createdBy === "ai" || item.category === "ai") &&
              normalizeGuideName(item.name || item.title || "guide") === normalizedName,
          )?.id ||
          createUserGuideId(),
        name: normalizedName,
        title: guide.title || normalizedName,
        content: guide.content || "# Guide\n",
        description: guide.description || "",
        category: "ai",
        createdBy: "ai",
        enabled: true,
        createdAt: guide.createdAt || now,
        updatedAt: now,
        indexJs: guide.indexJs || "",
      });
      setUserGuides((previous) => {
        const existingIndex = previous.findIndex((item) => item.id === normalized.id);
        if (existingIndex < 0) return [...previous, normalized];
        return previous.map((item, index) =>
          index === existingIndex ? { ...normalized, createdAt: item.createdAt } : item,
        );
      });
      return normalized;
    },
    [setUserGuides, userGuides],
  );

  const deleteGuide = useCallback(
    (id: string) => {
      setUserGuides((previous) => previous.filter((guide) => guide.id !== id));
    },
    [setUserGuides],
  );

  const toggleGuide = useCallback(
    (id: string, enabled: boolean) => {
      setUserGuides((previous) =>
        previous.map((guide) => (guide.id === id ? { ...guide, enabled, updatedAt: Date.now() } : guide)),
      );
    },
    [setUserGuides],
  );

  const importGuide = useCallback(
    async (file: File) => {
      if (/\.zip$/i.test(file.name)) {
        const entries = await readZipEntries(file);
        const mdEntries = Object.entries(entries).filter(([name]) => /\.md$/i.test(name));
        const mdEntry =
          mdEntries.find(([name]) => !/(^|\/)skillName\.md$/i.test(name)) ||
          mdEntries.find(([name]) => /(^|\/)skillName\.md$/i.test(name));
        const jsEntry = Object.entries(entries).find(([name]) => /(^|\/)index\.js$/i.test(name));
        if (!mdEntry || !jsEntry) {
          throw new Error("zip 指南必须包含一个 .md 指南文件和 index.js。 ");
        }
        const name = guideNameFromFile(mdEntry[0].split("/").pop() || file.name);
        return saveGuide({
          name,
          title: name,
          content: mdEntry[1],
          category: "read",
          indexJs: jsEntry[1],
          enabled: true,
        });
      }

      if (/\.md$/i.test(file.name)) {
        const content = await readTextFile(file);
        const name = guideNameFromFile(file.name);
        return saveGuide({ name, title: name, content, category: "read", enabled: true });
      }

      throw new Error("只支持导入 .md 或 .zip 指南。 ");
    },
    [saveGuide],
  );

  return {
    userGuides,
    saveGuide,
    createAiGuide,
    deleteGuide,
    toggleGuide,
    importGuide,
  };
};
