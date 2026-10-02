"use client";

// app/-rooted layout fixture (issue #1022): src/app/routes/gallery/ splits into
// app-gallery, so visiting /app-root/hero does not download this module.

import { useState } from "react";

export function Gallery() {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="app-gallery" className="mini-app-gallery">
      <button data-testid="app-gallery-btn" onClick={() => setOpen((o) => !o)}>
        app-gallery {open ? "open" : "closed"}
      </button>
    </div>
  );
}
