"use client";

import { useRouter } from "@rangojs/router/client";
import { FileTextIcon, HashIcon, SearchIcon } from "lucide-react";
import { Fragment, useEffect, useState } from "react";

import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTrigger,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
} from "@/components/ui/command";
import { Kbd, KbdGroup } from "@/components/ui/kbd";

interface SearchItem {
  value: string;
  label: string;
  hint?: string;
}

interface SearchGroup {
  value: "Pages" | "Sections";
  items: SearchItem[];
}

interface SearchIndex {
  pages: {
    title: string;
    url: string;
    description: string;
    headings: { text: string; id: string; depth: number }[];
  }[];
}

// The index is a JSON route (see src/routes/search-index.ts) fetched on the
// first open and cached for the page lifetime, so the palette costs nothing
// until it is used.
let indexPromise: Promise<SearchGroup[]> | null = null;

function loadIndex(): Promise<SearchGroup[]> {
  indexPromise ??= fetch("/search-index.json")
    .then((res) => res.json() as Promise<SearchIndex>)
    .then(({ pages }) => [
      {
        value: "Pages",
        items: pages.map((page) => ({
          value: page.url,
          label: page.title,
          hint: page.description,
        })),
      },
      {
        value: "Sections",
        items: pages.flatMap((page) =>
          page.headings
            .filter((heading) => heading.depth === 2)
            .map((heading) => ({
              value: `${page.url}#${heading.id}`,
              label: heading.text,
              hint: page.title,
            })),
        ),
      },
    ]);
  return indexPromise;
}

export function DocsSearch() {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<SearchGroup[] | null>(null);
  const router = useRouter();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open || groups) return;
    loadIndex()
      .then(setGroups)
      .catch(() => setGroups([]));
  }, [open, groups]);

  function select(item: SearchItem) {
    setOpen(false);
    void router.push(item.value);
  }

  return (
    <CommandDialog onOpenChange={(next) => setOpen(next)} open={open}>
      <CommandDialogTrigger className="hidden items-center gap-2 rounded-md border border-gray-alpha-400 bg-background-200 py-1.5 pr-2 pl-3 text-sm text-gray-700 transition-colors hover:border-gray-alpha-500 sm:flex">
        <SearchIcon className="size-3.5" />
        <span className="pr-6">Search docs…</span>
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      </CommandDialogTrigger>
      <CommandDialogPopup>
        <Command items={groups ?? []}>
          <CommandInput placeholder="Search the docs…" />
          <CommandPanel>
            <CommandEmpty>{groups ? "No results." : "Loading…"}</CommandEmpty>
            <CommandList>
              {(group: SearchGroup) => (
                <Fragment key={group.value}>
                  <CommandGroup items={group.items}>
                    <CommandGroupLabel>{group.value}</CommandGroupLabel>
                    <CommandCollection>
                      {(item: SearchItem) => (
                        <CommandItem
                          key={item.value}
                          onClick={() => select(item)}
                          value={item.value}
                        >
                          {group.value === "Pages" ? (
                            <FileTextIcon />
                          ) : (
                            <HashIcon />
                          )}
                          <span className="min-w-0 flex-1 truncate">
                            {item.label}
                          </span>
                          {item.hint ? (
                            <span className="ml-2 max-w-[45%] truncate text-muted-foreground text-xs">
                              {item.hint}
                            </span>
                          ) : null}
                        </CommandItem>
                      )}
                    </CommandCollection>
                  </CommandGroup>
                  <CommandSeparator />
                </Fragment>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <span className="flex items-center gap-2">
              <KbdGroup>
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
              </KbdGroup>
              Navigate
            </span>
            <span className="flex items-center gap-2">
              <Kbd>↵</Kbd>
              Open
            </span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
