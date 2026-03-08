import { urls } from "@rangojs/router";
import { StreamModeDelayedLoader } from "../loaders.js";

function StreamModeHandler(props: { message: string }) {
  return (
    <div data-testid="stream-mode-page">
      <p data-testid="stream-mode-message">{props.message}</p>
    </div>
  );
}

export const streamModePatterns = urls(({ path, loader, loading }) => [
  path(
    "/stream-mode-test",
    async (ctx) => {
      const { message } = await ctx.use(StreamModeDelayedLoader);
      return <StreamModeHandler message={message} />;
    },
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
