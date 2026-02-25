import { DebugSegmentWrapper } from "../components/DebugSegmentWrapper.js";

export function AboutPage() {
  return (
    <DebugSegmentWrapper type="route" name="About">
      <div>
        <h1>About</h1>
        <p className="segment-id">Segment: About Route</p>
        <p>This is a minimal RSC Router demo application.</p>
        <p>
          <a href="/">Back to home</a>
        </p>
      </div>
    </DebugSegmentWrapper>
  );
}
