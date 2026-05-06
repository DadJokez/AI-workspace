"use client";

interface Tab {
  id: string;
  title: string;
}

interface TabBarProps {
  tabs: readonly Tab[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** Pop the tab into a new window. Only callable for tabs with a real thread id. */
  onPopOut?: (id: string) => void;
}

export function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
  onPopOut,
}: TabBarProps) {
  return (
    <div className="flex h-9 shrink-0 items-end gap-px border-b border-zinc-200/80 bg-zinc-50 px-2 dark:border-zinc-800/80 dark:bg-zinc-900/40">
      <div className="flex flex-1 items-end gap-px overflow-x-auto">
        {tabs.map((t) => {
          const active = t.id === activeId;
          return (
            <div
              key={t.id}
              className={`group flex h-8 max-w-[200px] items-center gap-1 rounded-t-md border-b px-3 text-xs ${
                active
                  ? "border-transparent bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100"
                  : "border-transparent text-zinc-500 hover:bg-zinc-100/60 hover:text-zinc-800 dark:text-zinc-500 dark:hover:bg-zinc-800/40 dark:hover:text-zinc-200"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(t.id)}
                className="truncate"
                title={t.title}
              >
                {t.title}
              </button>
              {onPopOut && !t.id.startsWith("new:") ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPopOut(t.id);
                  }}
                  className={`ml-1 rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-100 ${
                    active ? "" : "opacity-0 group-hover:opacity-100"
                  }`}
                  aria-label="Pop out into new window"
                  title="Pop out"
                >
                  <PopOutIcon />
                </button>
              ) : null}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
                className={`ml-0.5 rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-100 ${
                  active ? "" : "opacity-0 group-hover:opacity-100"
                }`}
                aria-label="Close tab"
              >
                <CloseIcon />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={onNew}
          className="flex h-8 items-center justify-center rounded-t-md px-2 text-zinc-500 hover:bg-zinc-100/60 hover:text-zinc-800 dark:text-zinc-500 dark:hover:bg-zinc-800/40 dark:hover:text-zinc-200"
          aria-label="New chat tab"
          title="New chat"
        >
          <PlusIcon />
        </button>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function PopOutIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
