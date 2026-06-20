import * as React from "react";
import { Attachment, SubAgentProfile } from "./types";
import type { GuideSummary } from "./guideRegistry";

export interface MentionRange {
  start: number;
  end: number;
  name: string;
  agentId?: string;
}

export interface FileReferenceRange {
  start: number;
  end: number;
  name: string;
  attachmentName: string;
  nameStart: number;
  nameEnd: number;
  attachmentId?: string;
}

export interface GuideReferenceRange {
  start: number;
  end: number;
  name: string;
  title: string;
  guideId: string;
}

export interface ActiveMentionQuery {
  start: number;
  end: number;
  prefix: string;
  query: string;
}

export interface ActiveGuideQuery {
  start: number;
  end: number;
  query: string;
}

type InlineRange =
  | (MentionRange & { type: "mention" })
  | (FileReferenceRange & { type: "file" })
  | (GuideReferenceRange & { type: "guide" });

interface InlineRenderOptions {
  showFileReferenceBrackets?: boolean;
}

const getFileReferenceLabel = (range: FileReferenceRange, options?: InlineRenderOptions) =>
  options?.showFileReferenceBrackets ? `[file:${range.attachmentName}]` : range.name;

const getGuideReferenceLabel = (range: GuideReferenceRange) => `/${range.title}`;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const INLINE_REFERENCE_BOUNDARY = String.raw`(?=\s|$|[.,;:!?，。；：！？、）)\]}】》"'“”‘’])`;
const escapeFileReferenceName = (value: string) => value.replace(/]/g, "］");
const escapeGuideReferenceTitle = (value: string) => value.replace(/]/g, "］").trim();

const sortAgentsForMentionMatching = (agents: SubAgentProfile[]) =>
  [...agents]
    .filter((agent) => agent.name.trim())
    .sort((left, right) => right.name.length - left.name.length || left.name.localeCompare(right.name));

export const findSubAgentMentionRanges = (text: string, agents: SubAgentProfile[]): MentionRange[] => {
  const ranges: MentionRange[] = [];
  const sortedAgents = sortAgentsForMentionMatching(agents);
  if (!text || !sortedAgents.length) return ranges;

  const occupied = new Array(text.length).fill(false);
  for (const agent of sortedAgents) {
    const pattern = new RegExp(`(^|\\s)@${escapeRegExp(agent.name)}${INLINE_REFERENCE_BOUNDARY}`, "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const prefix = match[1] || "";
      const start = match.index + prefix.length;
      const end = start + agent.name.length + 1;
      if (occupied.slice(start, end).some(Boolean)) continue;
      for (let index = start; index < end; index += 1) occupied[index] = true;
      ranges.push({ start, end, name: agent.name, agentId: agent.id });
    }
  }

  return ranges.sort((left, right) => left.start - right.start);
};

const overlapsExistingRange = (ranges: Array<{ start: number; end: number }>, start: number, end: number) =>
  ranges.some((range) => start < range.end && end > range.start);

export const findGuideReferenceRanges = (text: string, guides: GuideSummary[] = []): GuideReferenceRange[] => {
  const ranges: GuideReferenceRange[] = [];
  if (!text || !guides.length) return ranges;

  const sortedGuides = [...guides]
    .filter((guide) => guide.enabled !== false && guide.title.trim())
    .sort((left, right) => right.title.length - left.title.length || left.title.localeCompare(right.title));
  for (const guide of sortedGuides) {
    const title = escapeGuideReferenceTitle(guide.title);
    const pattern = new RegExp(`(^|\\s)\\/${escapeRegExp(title)}${INLINE_REFERENCE_BOUNDARY}`, "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const prefix = match[1] || "";
      const start = match.index + prefix.length;
      const end = start + title.length + 1;
      if (overlapsExistingRange(ranges, start, end)) continue;
      ranges.push({ start, end, name: guide.name, title, guideId: guide.id });
    }
  }

  return ranges.sort((left, right) => left.start - right.start || left.end - right.end);
};

export const findAttachmentReferenceRanges = (text: string, attachments: Attachment[] = []): FileReferenceRange[] => {
  const ranges: FileReferenceRange[] = [];
  if (!text) return ranges;

  const attachmentsByName = new Map<string, Attachment[]>();
  attachments.forEach((attachment) => {
    const name = escapeFileReferenceName(attachment.name);
    attachmentsByName.set(name, [...(attachmentsByName.get(name) || []), attachment]);
  });

  const bracketPattern = /\[file:([^\]\n]+)]/g;
  let match: RegExpExecArray | null;
  const usedByName = new Map<string, number>();
  while ((match = bracketPattern.exec(text))) {
    const attachmentName = match[1];
    const candidates = attachmentsByName.get(attachmentName) || [];
    const usedIndex = usedByName.get(attachmentName) || 0;
    const attachment = candidates[usedIndex] || candidates[0];
    usedByName.set(attachmentName, usedIndex + 1);
    const nameStart = match.index + "[file:".length;
    const nameEnd = nameStart + attachmentName.length;
    ranges.push({
      start: match.index,
      end: match.index + match[0].length,
      name: attachmentName,
      attachmentName,
      nameStart,
      nameEnd,
      attachmentId: attachment?.id,
    });
  }

  const sortedAttachments = [...attachments]
    .filter((attachment) => attachment.name.trim())
    .sort((left, right) => right.name.length - left.name.length || left.name.localeCompare(right.name));
  for (const attachment of sortedAttachments) {
    const attachmentName = escapeFileReferenceName(attachment.name);
      const pattern = new RegExp(`(^|\\s)${escapeRegExp(attachmentName)}${INLINE_REFERENCE_BOUNDARY}`, "g");
    while ((match = pattern.exec(text))) {
      const prefix = match[1] || "";
      const start = match.index + prefix.length;
      const end = start + attachmentName.length;
      if (overlapsExistingRange(ranges, start, end)) continue;
      ranges.push({
        start,
        end,
        name: attachmentName,
        attachmentName,
        nameStart: start,
        nameEnd: end,
        attachmentId: attachment.id,
      });
    }
  }

  return ranges.sort((left, right) => left.start - right.start || left.end - right.end);
};

export const getActiveMentionQuery = (text: string, selectionStart: number, selectionEnd = selectionStart): ActiveMentionQuery | null => {
  if (selectionStart !== selectionEnd) return null;
  const beforeCursor = text.slice(0, selectionStart);
  const match = /(^|\s)@([^\s@]*)$/.exec(beforeCursor);
  if (!match) return null;
  const prefix = match[1] || "";
  const start = selectionStart - match[0].length + prefix.length;
  return {
    start,
    end: selectionStart,
    prefix,
    query: match[2] || "",
  };
};

export const getActiveGuideQuery = (text: string, selectionStart: number, selectionEnd = selectionStart): ActiveGuideQuery | null => {
  if (selectionStart !== selectionEnd) return null;
  const beforeCursor = text.slice(0, selectionStart);
  const match = /(^|\s)\/([^\s/]*)$/.exec(beforeCursor);
  if (!match) return null;
  const prefix = match[1] || "";
  const start = selectionStart - match[0].length + prefix.length;
  return {
    start,
    end: selectionStart,
    query: match[2] || "",
  };
};

export const replaceActiveMentionQuery = (text: string, activeMention: ActiveMentionQuery, name: string) => {
  const mentionText = `@${name}`;
  const suffix = text[activeMention.end] === " " ? "" : " ";
  const nextText = `${text.slice(0, activeMention.start)}${mentionText}${suffix}${text.slice(activeMention.end)}`;
  const nextCursor = activeMention.start + mentionText.length + 1;
  return { text: nextText, cursor: nextCursor };
};

export const replaceActiveGuideQuery = (text: string, activeGuide: ActiveGuideQuery, guide: GuideSummary) => {
  const guideText = `/${escapeGuideReferenceTitle(guide.title)}`;
  const suffix = text[activeGuide.end] === " " ? "" : " ";
  const nextText = `${text.slice(0, activeGuide.start)}${guideText}${suffix}${text.slice(activeGuide.end)}`;
  const nextCursor = activeGuide.start + guideText.length + 1;
  return { text: nextText, cursor: nextCursor };
};

export const insertAttachmentReference = (text: string, selectionStart: number, selectionEnd: number, attachment: Attachment) => {
  const referenceText = escapeFileReferenceName(attachment.name);
  const prefix = selectionStart > 0 && !/\s/.test(text[selectionStart - 1]) ? " " : "";
  const suffix = text[selectionEnd] === " " ? "" : " ";
  const nextText = `${text.slice(0, selectionStart)}${prefix}${referenceText}${suffix}${text.slice(selectionEnd)}`;
  const cursor = selectionStart + prefix.length + referenceText.length + 1;
  return { text: nextText, cursor };
};

const findRangeTouchingDelete = <T extends { start: number; end: number }>(
  ranges: T[],
  selectionStart: number,
  selectionEnd: number,
  key: string,
) => {
  if (selectionStart !== selectionEnd) {
    return ranges.find((range) => selectionStart < range.end && selectionEnd > range.start) || null;
  }
  if (key === "Backspace") {
    return ranges.find((range) => selectionStart > range.start && selectionStart <= range.end) || null;
  }
  if (key === "Delete") {
    return ranges.find((range) => selectionStart >= range.start && selectionStart < range.end) || null;
  }
  return null;
};

export const applyMentionAtomicDelete = (
  text: string,
  ranges: Array<{ start: number; end: number }>,
  selectionStart: number,
  selectionEnd: number,
  key: "Backspace" | "Delete",
) => {
  const range = findRangeTouchingDelete(ranges, selectionStart, selectionEnd, key);
  if (!range) return null;
  const nextText = `${text.slice(0, range.start)}${text.slice(range.end)}`;
  return { text: nextText, cursor: range.start, deletedRange: range };
};

export const expandSelectionToMentionBoundaries = (
  ranges: Array<{ start: number; end: number }>,
  selectionStart: number,
  selectionEnd: number,
) => {
  let start = selectionStart;
  let end = selectionEnd;
  let changed = false;

  for (const range of ranges) {
    if (start > range.start && start < range.end) {
      start = range.start;
      changed = true;
    }
    if (end > range.start && end < range.end) {
      end = range.end;
      changed = true;
    }
  }

  return changed ? { start, end } : null;
};

const mergeInlineRanges = (
  mentionRanges: MentionRange[],
  fileRanges: FileReferenceRange[],
  guideRanges: GuideReferenceRange[] = [],
): InlineRange[] =>
  [
    ...mentionRanges.map((range): InlineRange => ({ ...range, type: "mention" })),
    ...fileRanges.map((range): InlineRange => ({ ...range, type: "file" })),
    ...guideRanges.map((range): InlineRange => ({ ...range, type: "guide" })),
  ].sort((left, right) => left.start - right.start || left.end - right.end);

export const renderMentionInlineNodes = (
  text: string,
  ranges: MentionRange[],
  tokenClassName: string,
  textClassName?: string,
) => renderComposerInlineNodes(text, ranges, [], tokenClassName, tokenClassName, textClassName);

export const renderComposerInlineNodes = (
  text: string,
  mentionRanges: MentionRange[],
  fileRanges: FileReferenceRange[],
  mentionTokenClassName: string,
  fileTokenClassName: string,
  textClassName?: string,
  options?: InlineRenderOptions,
  guideRanges: GuideReferenceRange[] = [],
  guideTokenClassName = fileTokenClassName,
) => {
  const nodes: React.ReactNode[] = [];
  const ranges = mergeInlineRanges(mentionRanges, fileRanges, guideRanges);
  let cursor = 0;

  ranges.forEach((range, index) => {
    if (range.start < cursor) return;
    if (range.start > cursor) {
      nodes.push(
        React.createElement(
          "span",
          { key: `text-${cursor}-${range.start}`, className: textClassName },
          text.slice(cursor, range.start),
        ),
      );
    }
    if (range.type === "mention") {
      nodes.push(
        React.createElement(
          "span",
          {
            key: `mention-${range.start}-${range.end}-${index}`,
            className: mentionTokenClassName,
            contentEditable: false,
            draggable: false,
            "data-ai-composer-token": "true",
            "data-agent-id": range.agentId,
          },
          `@${range.name}`,
        ),
      );
    } else if (range.type === "file") {
      nodes.push(
        React.createElement(
          "span",
          {
            key: `file-${range.start}-${range.end}-${index}`,
            className: fileTokenClassName,
            contentEditable: false,
            draggable: false,
            "data-ai-composer-token": "true",
            "data-attachment-id": range.attachmentId,
            "data-file-name": range.name,
          },
          getFileReferenceLabel(range, options),
        ),
      );
    } else {
      nodes.push(
        React.createElement(
          "span",
          {
            key: `guide-${range.start}-${range.end}-${index}`,
            className: guideTokenClassName,
            contentEditable: false,
            draggable: false,
            "data-ai-composer-token": "true",
            "data-guide-id": range.guideId,
            "data-guide-name": range.name,
          },
          getGuideReferenceLabel(range),
        ),
      );
    }
    if (text[range.end] === " ") {
      nodes.push(
        React.createElement(
          "span",
          {
            key: `token-space-${range.start}-${range.end}-${index}`,
            contentEditable: false,
            draggable: false,
            "data-ai-token-space": "true",
          },
          " ",
        ),
      );
      cursor = range.end + 1;
    } else {
      cursor = range.end;
    }
  });

  if (cursor < text.length) {
    nodes.push(
      React.createElement(
        "span",
        { key: `text-${cursor}-${text.length}`, className: textClassName },
        text.slice(cursor),
      ),
    );
  }

  return nodes.length ? nodes : text;
};

export const renderMessageInlineNodes = (
  text: string,
  mentionRanges: MentionRange[],
  fileRanges: FileReferenceRange[],
  mentionTokenClassName: string,
  fileTokenClassName: string,
  onFileClick?: (attachmentId?: string, fileName?: string) => void,
  options?: InlineRenderOptions,
  guideRanges: GuideReferenceRange[] = [],
  guideTokenClassName = fileTokenClassName,
) => {
  const nodes: React.ReactNode[] = [];
  const ranges = mergeInlineRanges(mentionRanges, fileRanges, guideRanges);
  let cursor = 0;

  ranges.forEach((range, index) => {
    if (range.start < cursor) return;
    if (range.start > cursor) {
      nodes.push(React.createElement("span", { key: `text-${cursor}-${range.start}` }, text.slice(cursor, range.start)));
    }
    if (range.type === "mention") {
      nodes.push(
        React.createElement(
          "span",
          { key: `mention-${range.start}-${range.end}-${index}`, className: mentionTokenClassName, "data-agent-id": range.agentId },
          `@${range.name}`,
        ),
      );
    } else if (range.type === "file") {
      nodes.push(
        React.createElement(
          "button",
          {
            key: `file-${range.start}-${range.end}-${index}`,
            type: "button",
            className: fileTokenClassName,
            "data-attachment-id": range.attachmentId,
            "data-file-name": range.name,
            onClick: () => onFileClick?.(range.attachmentId, range.name),
          },
          getFileReferenceLabel(range, options),
        ),
      );
    } else {
      nodes.push(
        React.createElement(
          "span",
          {
            key: `guide-${range.start}-${range.end}-${index}`,
            className: guideTokenClassName,
            "data-guide-id": range.guideId,
            "data-guide-name": range.name,
          },
          getGuideReferenceLabel(range),
        ),
      );
    }
    cursor = range.end;
  });

  if (cursor < text.length) {
    nodes.push(React.createElement("span", { key: `text-${cursor}-${text.length}` }, text.slice(cursor)));
  }

  return nodes.length ? nodes : text;
};

const replaceAttachmentNamesWithFileReferences = (inputText: string, ranges: FileReferenceRange[]) => {
  if (!ranges.length) return inputText;
  let cursor = 0;
  const parts: string[] = [];
  ranges.forEach((range) => {
    if (range.start < cursor) return;
    parts.push(inputText.slice(cursor, range.start));
    parts.push(`[file:${range.attachmentName}]`);
    cursor = range.end;
  });
  parts.push(inputText.slice(cursor));
  return parts.join("");
};

const replaceGuideTitlesWithReferences = (inputText: string, ranges: GuideReferenceRange[]) => {
  if (!ranges.length) return inputText;
  let cursor = 0;
  const parts: string[] = [];
  ranges.forEach((range) => {
    if (range.start < cursor) return;
    parts.push(inputText.slice(cursor, range.start));
    parts.push(`[guide:${range.title}]`);
    cursor = range.end;
  });
  parts.push(inputText.slice(cursor));
  return parts.join("");
};

export const buildModelContentWithReferences = (inputText: string, attachments: Attachment[] = [], guides: GuideSummary[] = []) => {
  const fileReferenceRanges = findAttachmentReferenceRanges(inputText, attachments);
  const guideReferenceRanges = findGuideReferenceRanges(inputText, guides);
  const referencedFileNames = new Set(fileReferenceRanges.map((range) => range.attachmentName));
  const referencedGuideIds = new Set(guideReferenceRanges.map((range) => range.guideId));
  const getAttachmentModelContent = (attachment: Attachment) => {
    const name = escapeFileReferenceName(attachment.name);
    if (attachment.kind === "workspace-ucf" || attachment.kind === "workspace-ucf-range") {
      const meta = attachment.meta || {};
      const details = [
        meta.source ? `source=${meta.source}` : "",
        meta.targetId ? `targetId=${meta.targetId}` : "",
        meta.blockId ? `blockId=${meta.blockId}` : "",
        meta.startBlockId && meta.endBlockId ? `range=${meta.startBlockId}..${meta.endBlockId}` : "",
        typeof meta.blockCount === "number" ? `blockCount=${meta.blockCount}` : "",
      ].filter(Boolean);
      return `[file:${name}] (${attachment.kind})${details.length ? ` [${details.join(", ")}]` : ""}:\nWorkspace block content is omitted from model context. Use the virtual file reference in the user message, searchFiles/readFile when project index is available, or ask the user to build the project index first.`;
    }
    return `[file:${name}] (${attachment.kind}):\n${attachment.content}`;
  };
  const referencedFilesContent = attachments
    .map(getAttachmentModelContent)
    .join("\n\n");
  const missingFileReferences = attachments
    .map((attachment) => escapeFileReferenceName(attachment.name))
    .filter((name) => !referencedFileNames.has(name))
    .map((name) => `[file:${name}]`)
    .join(" ");
  const referencedGuideContent = guides
    .filter((guide) => guide.enabled !== false && referencedGuideIds.has(guide.id))
    .map((guide) => `[guide:${escapeGuideReferenceTitle(guide.title)}] (${guide.source}/${guide.category}):\n${guide.content}`)
    .join("\n\n");
  const fileReferencedContent = replaceAttachmentNamesWithFileReferences(inputText, fileReferenceRanges);
  const guideReferencedContent = replaceGuideTitlesWithReferences(fileReferencedContent, guideReferenceRanges);
  const visibleContent = [guideReferencedContent, missingFileReferences].filter(Boolean).join(guideReferencedContent ? " " : "");
  return [
    visibleContent,
    referencedFilesContent ? `=== Referenced Files ===\n${referencedFilesContent}` : "",
    referencedGuideContent ? `=== Referenced Guides ===\n${referencedGuideContent}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

export const buildModelContentWithAttachmentReferences = (inputText: string, attachments: Attachment[] = []) =>
  buildModelContentWithReferences(inputText, attachments, []);
