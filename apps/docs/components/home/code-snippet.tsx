import type { HTMLAttributes } from "react";

import { Pre } from "@/components/code-block";
import { cn } from "@/lib/utils";

// MDX `pre` mapping for homepage snippets: the Shiki output keeps its inline
// theme colors; this adds the block chrome the docs get from `.prose`.
function SnippetPre({ className, ...props }: HTMLAttributes<HTMLPreElement>) {
  return (
    <Pre
      {...props}
      className={cn(
        "overflow-x-auto rounded-xl border border-gray-alpha-400 p-4 font-mono text-[13px] leading-6",
        className,
      )}
    />
  );
}

export const snippetComponents = { pre: SnippetPre };
