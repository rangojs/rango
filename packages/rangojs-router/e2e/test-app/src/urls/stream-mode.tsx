import { urls } from "@rangojs/router";
import { StreamModeDelayedLoader } from "../loaders.js";
import { StreamModeContent } from "../components/StreamModeContent.js";

export const streamModePatterns = urls(({ path, loader, loading }) => [
  path(
    "/stream-mode-test",
    () => <StreamModeContent loader={StreamModeDelayedLoader} />,
    { name: "streamModeTest" },
    () => [
      loader(StreamModeDelayedLoader),
      loading(
        <div data-testid="stream-mode-loading">
          <p>stream-mode-loading-fallback</p>
        </div>,
      ),
    ],
  ),
]);
