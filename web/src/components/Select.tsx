/**
 * Shared dropdown primitive.
 *
 * Fully self-drawn, accessible listbox. Stable contract (other pages code
 * against it — do not change the prop names/shapes):
 *
 *   <Select value={string} onChange={(value) => void} options={SelectOption[]}
 *           placeholder? ariaLabel? disabled? className? size? searchable?
 *           id? name? />
 *
 * Behaviour highlights:
 * - Keyboard: Tab to focus, ArrowUp/Down, Enter, Esc, Home/End, type-ahead.
 * - Click outside closes; Escape only closes the dropdown (never the parent
 *   dialog); scrolling/resizing repositions or closes the panel.
 * - The panel is rendered through a portal with `position: fixed` + computed
 *   coordinates, so it is never clipped by an `overflow: hidden` dialog.
 * - The panel background is an opaque solid (`var(--surface)`), not glass.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "../lib/utils";
import "./Select.css";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  color?: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
  searchable?: boolean;
  id?: string;
  name?: string;
}

const PANEL_GAP = 6;
const PANEL_EDGE = 8;
const PANEL_MAX_HEIGHT = 320;
const PANEL_MIN_WIDTH = 128;
const TYPEAHEAD_RESET_MS = 700;
const OPEN_SCROLL_GRACE_MS = 260;

function firstEnabledIndex(list: SelectOption[], from: number, direction: 1 | -1): number {
  if (!list.length) return -1;
  let index = from;
  for (let step = 0; step < list.length; step += 1) {
    index = (index + direction + list.length) % list.length;
    if (!list[index]?.disabled) return index;
  }
  return -1;
}

function filterOptions(options: SelectOption[], query: string): SelectOption[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return options;
  return options.filter((option) => {
    const haystack = `${option.label} ${option.description ?? ""}`.toLowerCase();
    return haystack.includes(keyword);
  });
}

export function Select({
  value,
  onChange,
  options,
  placeholder = "请选择",
  ariaLabel,
  disabled = false,
  className,
  size = "md",
  searchable = false,
  id,
  name,
}: SelectProps) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const typeaheadRef = useRef({ text: "", at: 0 });
  const openedAtRef = useRef(0);
  const reactId = useId();
  const listId = `ts-select-list-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const optionId = (index: number) => `${listId}-option-${index}`;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [query, setQuery] = useState("");
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const [isTop, setIsTop] = useState(false);

  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  );
  const filtered = useMemo(
    () => (searchable ? filterOptions(options, query) : options),
    [options, query, searchable],
  );

  const closePanel = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
  }, []);

  const openPanel = useCallback(() => {
    if (disabled) return;
    const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
    setQuery("");
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : firstEnabledIndex(options, -1, 1));
    openedAtRef.current = Date.now();
    setOpen(true);
  }, [disabled, options, value]);

  /* ---------------------------------------------------------------- */
  /* Positioning: fixed coordinates relative to the trigger button.    */
  /* ---------------------------------------------------------------- */
  const computePanelPosition = useCallback(() => {
    const trigger = triggerButtonRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    // Keep the popup flush with the trigger (like a native select) so the list
    // never looks horizontally offset; only very narrow triggers get a small
    // minimum for readable option labels.
    const width = Math.min(Math.max(rect.width, PANEL_MIN_WIDTH), viewportWidth - PANEL_EDGE * 2);
    const left = Math.min(
      Math.max(PANEL_EDGE, rect.left),
      Math.max(PANEL_EDGE, viewportWidth - width - PANEL_EDGE),
    );
    const estimatedHeight = Math.min(
      (searchable ? 44 : 0) + Math.max(filtered.length, 1) * 36 + 12,
      PANEL_MAX_HEIGHT,
    );
    const spaceBelow = viewportHeight - rect.bottom - PANEL_GAP - PANEL_EDGE;
    const spaceAbove = rect.top - PANEL_GAP - PANEL_EDGE;
    const placeTop = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
    const available = placeTop ? spaceAbove : spaceBelow;
    const maxHeight = Math.max(96, Math.min(Math.floor(available), PANEL_MAX_HEIGHT));
    setIsTop(placeTop);
    setPanelStyle(
      placeTop
        ? { left, width, bottom: viewportHeight - rect.top + PANEL_GAP, maxHeight }
        : { left, width, top: rect.bottom + PANEL_GAP, maxHeight },
    );
  }, [filtered.length, searchable]);

  useLayoutEffect(() => {
    if (open) computePanelPosition();
  }, [open, computePanelPosition]);

  /* Close/reposition on page scroll and window resize. */
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const trigger = triggerButtonRef.current;
        if (!trigger) return;
        const rect = trigger.getBoundingClientRect();
        if (rect.bottom < 4 || rect.top > window.innerHeight - 4) {
          closePanel();
          return;
        }
        computePanelPosition();
      });
    };
    const onScrollOrResize = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      if (Date.now() - openedAtRef.current < OPEN_SCROLL_GRACE_MS) return;
      schedule();
    };
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [open, closePanel, computePanelPosition]);

  /* Click outside closes (capture phase so nested stopPropagation cannot hide it). */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      closePanel();
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [open, closePanel]);

  /* Focus the search field when the searchable panel opens. */
  useEffect(() => {
    if (!open || !searchable) return;
    const timer = window.setTimeout(() => searchRef.current?.focus(), 20);
    return () => window.clearTimeout(timer);
  }, [open, searchable]);

  /* Keep the highlighted option inside the visible list area. */
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const node = listRef.current?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  /* Clamp the highlight when the option set changes. */
  useEffect(() => {
    if (!open) return;
    setActiveIndex((current) => {
      if (!filtered.length) return -1;
      if (current >= 0 && current < filtered.length && !filtered[current]?.disabled) return current;
      return firstEnabledIndex(filtered, -1, 1);
    });
  }, [open, filtered]);

  const chooseOption = useCallback(
    (option: SelectOption) => {
      if (option.disabled) return;
      if (option.value !== value) onChange(option.value);
      closePanel();
      triggerButtonRef.current?.focus();
    },
    [closePanel, onChange, value],
  );

  const moveActive = useCallback(
    (direction: 1 | -1) => {
      setActiveIndex((current) => firstEnabledIndex(filtered, current, direction));
    },
    [filtered],
  );

  const runTypeahead = useCallback(
    (key: string) => {
      const now = Date.now();
      const previous = now - typeaheadRef.current.at < TYPEAHEAD_RESET_MS ? typeaheadRef.current.text : "";
      const text = (previous + key).toLowerCase();
      typeaheadRef.current = { text, at: now };
      if (!open) openPanel();
      const start = activeIndex >= 0 ? activeIndex + 1 : 0;
      let match = -1;
      for (let step = 0; step < options.length; step += 1) {
        const index = (start + step) % options.length;
        const option = options[index];
        if (!option.disabled && option.label.toLowerCase().startsWith(text)) {
          match = index;
          break;
        }
      }
      if (match < 0 && text.length > 1) {
        for (let step = 0; step < options.length; step += 1) {
          const index = (start + step) % options.length;
          const option = options[index];
          if (!option.disabled && option.label.toLowerCase().includes(text)) {
            match = index;
            break;
          }
        }
      }
      if (match >= 0) setActiveIndex(match);
    },
    [activeIndex, open, openPanel, options],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (disabled) return;
      const fromSearch = event.target === searchRef.current;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          if (!open) openPanel();
          else moveActive(1);
          break;
        case "ArrowUp":
          event.preventDefault();
          if (!open) openPanel();
          else moveActive(-1);
          break;
        case "Home":
          if (!open) return;
          event.preventDefault();
          setActiveIndex(firstEnabledIndex(filtered, -1, 1));
          break;
        case "End":
          if (!open) return;
          event.preventDefault();
          setActiveIndex(firstEnabledIndex(filtered, 0, -1));
          break;
        case "Enter": {
          event.preventDefault();
          if (!open) {
            openPanel();
            break;
          }
          const option = filtered[activeIndex];
          if (option) chooseOption(option);
          break;
        }
        case " ":
          if (fromSearch) break;
          if (!open) break; // native button click opens the panel
          event.preventDefault();
          if (filtered[activeIndex]) chooseOption(filtered[activeIndex]);
          break;
        case "Escape":
          if (!open) break;
          event.preventDefault();
          // Keep a surrounding Modal open: only this dropdown should close.
          event.stopPropagation();
          closePanel();
          triggerButtonRef.current?.focus();
          break;
        case "Tab":
          if (open) closePanel();
          break;
        default: {
          if (fromSearch || searchable) break;
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            runTypeahead(event.key);
          }
          break;
        }
      }
    },
    [activeIndex, chooseOption, closePanel, disabled, filtered, moveActive, open, openPanel, runTypeahead, searchable],
  );

  const handleSearchChange = (next: string) => {
    setQuery(next);
    setActiveIndex(firstEnabledIndex(filterOptions(options, next), -1, 1));
  };

  const handleTriggerClick = () => {
    if (disabled) return;
    if (open) closePanel();
    else openPanel();
  };

  const activeOption = open && activeIndex >= 0 ? filtered[activeIndex] : undefined;
  const activeOptionId = activeOption ? optionId(activeIndex) : undefined;

  return (
    <div
      ref={triggerRef}
      className={cn(
        "ts-select",
        `ts-select-${size}`,
        open && "is-open",
        disabled && "is-disabled",
        className,
      )}
    >
      <button
        ref={triggerButtonRef}
        type="button"
        id={id}
        className="ts-select-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={activeOptionId}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={handleTriggerClick}
        onKeyDown={handleKeyDown}
      >
        {selected ? (
          <span className="ts-select-value">
            {selected.color ? (
              <span className="ts-select-dot" style={{ background: selected.color }} aria-hidden="true" />
            ) : null}
            <span className="ts-select-value-label">{selected.label}</span>
          </span>
        ) : (
          <span className="ts-select-placeholder">{placeholder}</span>
        )}
        <ChevronsUpDown size={14} className="ts-select-caret" aria-hidden="true" />
      </button>
      {name ? <input type="hidden" name={name} value={value} /> : null}

      {open
        ? createPortal(
            <div
              ref={panelRef}
              className={cn("ts-select-panel", isTop && "is-top")}
              style={panelStyle}
              onKeyDown={handleKeyDown}
            >
              {searchable ? (
                <div className="ts-select-search">
                  <Search size={13} aria-hidden="true" />
                  <input
                    ref={searchRef}
                    className="ts-select-search-input"
                    value={query}
                    placeholder="搜索选项…"
                    aria-label={ariaLabel ? `${ariaLabel}：搜索选项` : "搜索选项"}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={open}
                    aria-controls={listId}
                    aria-activedescendant={activeOptionId}
                    onChange={(event) => handleSearchChange(event.target.value)}
                    onKeyDown={handleKeyDown}
                  />
                </div>
              ) : null}
              <ul ref={listRef} id={listId} className="ts-select-list" role="listbox" aria-label={ariaLabel ?? placeholder}>
                {filtered.length ? (
                  filtered.map((option, index) => {
                    const isSelected = option.value === value;
                    return (
                      <li
                        key={`${option.value}-${index}`}
                        id={optionId(index)}
                        data-option-index={index}
                        role="option"
                        aria-selected={isSelected}
                        aria-disabled={option.disabled || undefined}
                        className={cn(
                          "ts-select-option",
                          index === activeIndex && "is-active",
                          isSelected && "is-selected",
                          option.disabled && "is-disabled",
                        )}
                        onMouseDown={(event) => {
                          // Avoid stealing focus from the search box / trigger.
                          event.preventDefault();
                          if (!option.disabled) setActiveIndex(index);
                        }}
                        onMouseEnter={() => {
                          if (!option.disabled) setActiveIndex(index);
                        }}
                        onClick={() => chooseOption(option)}
                      >
                        {option.color ? (
                          <span className="ts-select-option-dot" style={{ background: option.color }} aria-hidden="true" />
                        ) : null}
                        <span className="ts-select-option-main">
                          <span className="ts-select-option-label">{option.label}</span>
                          {option.description ? (
                            <span className="ts-select-option-desc">{option.description}</span>
                          ) : null}
                        </span>
                        {isSelected ? <Check size={14} className="ts-select-check" aria-hidden="true" /> : null}
                      </li>
                    );
                  })
                ) : (
                  <li className="ts-select-empty">没有匹配的选项</li>
                )}
              </ul>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export type { SelectOption as SelectOptionType };
