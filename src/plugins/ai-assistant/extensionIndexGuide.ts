import { APPROVED_EXTENSION_INDEX } from "./approvedExtensionIndex";

export const APPROVED_EXTENSION_INDEX_GUIDE_TOPIC = "extension-index";
export const APPROVED_EXTENSION_INDEX_GUIDE_TITLE = "Approved extension index";

export const getAvailableApprovedExtensions = () =>
  APPROVED_EXTENSION_INDEX.filter((extension) => !extension.disabled).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

export const buildApprovedExtensionIndexGuideContent = () =>
  [
    "# Approved extension index",
    "",
    "Use this guide to quickly decide which approved extension may fit a user request.",
    "Use `searchExtensions` for focused search and `addExtension` with the listed extension id to add one.",
    "",
    ...getAvailableApprovedExtensions().map(
      (extension) => `- ${extension.name} [${extension.extensionId}]: ${extension.description || extension.extensionId}`,
    ),
  ].join("\n");

export const buildApprovedExtensionIndexGuideRules = () => [
  "Use this guide to quickly decide which approved extension may fit a user request.",
  "Use searchExtensions for focused search and addExtension with the listed extension id to add one.",
  ...getAvailableApprovedExtensions().map(
    (extension) => `${extension.name} [${extension.extensionId}]: ${extension.description || extension.extensionId}`,
  ),
];
