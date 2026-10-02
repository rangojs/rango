"use client";

// app/-rooted layout fixture (issue #1022): src/app/routes/split-gallery/ is
// its own client group (app-split-gallery), so /app-root/hero does not
// download this module.

import { useState } from "react";

export function SplitGallery() {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="split-gallery" className="cf-app-split-gallery">
      <button
        data-testid="split-gallery-btn"
        onClick={() => setOpen((o) => !o)}
      >
        split-gallery {open ? "open" : "closed"}
      </button>
    </div>
  );
}
