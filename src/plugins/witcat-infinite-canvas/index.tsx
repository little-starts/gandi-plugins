import * as React from "react";
import toast from "react-hot-toast";
import Icon from "./icon";
import { UploadIcon } from "./upload-icon";

declare const window: Window & {
  scratchPaintInfiniteCanvas: boolean;
};

const WitcatInfiniteCanvas: React.FC<PluginContext> = ({ registerSettings, msg, utils, vm }) => {
  const handleOriginalUpload = React.useCallback(() => {
    if (!vm.editingTarget) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".svg, .png, .jpg, .jpeg";
    input.onchange = (e: Event) => {
      const target = e.target as HTMLInputElement;
      const file = target.files?.[0];
      if (!file) return;

      const ext = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();
      if (![".svg", ".png", ".jpg", ".jpeg"].includes(ext)) {
        toast.error(msg("plugins.witcatInfiniteCanvas.unsupportedFileExtension"));
        return;
      }

      const reader = new FileReader();
      reader.onerror = () => {
        toast.error(msg("plugins.witcatInfiniteCanvas.fileReaderError"));
      };

      if (file.type === "image/svg+xml" || ext === ".svg") {
        reader.onload = (readerEvent) => {
          const content = readerEvent.target?.result as string;
          if (!content) return;
          utils.addCostumeToTarget(
            content,
            file.name,
            "image/svg+xml",
            vm.editingTarget.id
          );
        };
        reader.readAsText(file);
      } else {
        reader.onload = (readerEvent) => {
          const result = readerEvent.target?.result as string;
          if (!result) return;

          const img = new Image();
          img.onload = () => {
            const svg = `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${img.width}" height="${img.height}" viewBox="0 0 ${img.width} ${img.height}"><image width="${img.width}" height="${img.height}" xlink:href="${result}" /></svg>`;
            utils.addCostumeToTarget(
              svg,
              file.name.replace(/\.[^/.]+$/, "") + ".svg",
              "image/svg+xml",
              vm.editingTarget.id
            );
          };
          img.onerror = () => {
            toast.error(msg("plugins.witcatInfiniteCanvas.imageLoadError"));
          };
          img.src = result;
        };
        reader.readAsDataURL(file);
      }
      input.remove();
    };
    input.click();
  }, [utils, vm]);

  React.useEffect(() => {
    const register = registerSettings(
      msg("plugins.witcatInfiniteCanvas.title"),
      "witcat-infinite-canvas",
      [
        {
          key: "settings",
          label: msg("plugins.witcatInfiniteCanvas.title"),
          items: [
            {
              key: "open",
              type: "switch",
              label: msg("plugins.witcatInfiniteCanvas.open"),
              value: false,
              onChange(v: boolean) {
                window.scratchPaintInfiniteCanvas = v;
              },
            },
            {
              key: "originalImageUpload",
              type: "switch",
              label: msg("plugins.witcatInfiniteCanvas.originalImageUpload"),
              value: false,
              onChange(v: boolean) {
                if (v) {
                  utils.expandCostumeMenuItems([
                    {
                      id: "originalImageUpload",
                      title: msg("plugins.witcatInfiniteCanvas.originalImageUpload"),
                      img: UploadIcon,
                      onClick: handleOriginalUpload,
                    },
                  ]);
                } else {
                  utils.removeCostumeMenuItems(["originalImageUpload"]);
                }
              },
            },
          ],
        },
      ],
      <Icon></Icon>
    );
    return () => {
      window.scratchPaintInfiniteCanvas = false;
      utils.removeCostumeMenuItems(["originalImageUpload"]);
      register.dispose();
    };
  }, [registerSettings, msg, utils, handleOriginalUpload]);

  return null;
};

WitcatInfiniteCanvas.displayName = "WitcatInfiniteCanvas";

export default WitcatInfiniteCanvas;
