export interface ExtensionVersion {
  id: string;
  label: string;
  url: string;
  releasedAt?: string | number;
  changelog?: string;
  releaseTags: string[];
}

export interface MarketplaceExtensionDetail {
  eid: string;
  name: string;
  versions: ExtensionVersion[];
}

export interface ManagedCustomExtension {
  id: string;
  name: string;
  currentUrl: string;
}
