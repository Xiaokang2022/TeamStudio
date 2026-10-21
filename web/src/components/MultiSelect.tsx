/**
 * Shared multi-select primitive (member picker etc.).
 *
 * Fully self-drawn, accessible multi-select listbox with the same visual and
 * behavioural language as `components/Select.tsx` (which stays untouched):
 *
 *   <MultiSelect value={string[]} onChange={(next: string[]) => void}
 *                options={MultiSelectOption[]} placeholder? ariaLabel? max?
 *                searchable? disabled? size? className? id? name? />
 *
 * Behaviour highlights:
 * - Trigger shows the selected members as compact avatar chips plus a "+N"
 *   overflow counter; the full list is available from the trigger title.
 * - Portal panel (`position: fixed`, opaque `var(--surface)`) with search,
 *   checkbox-style rows (avatar + name + title) and a footer count/clear.
 * - Keyboard: Enter/Space/ArrowDown/ArrowUp open the panel, ArrowUp/Down and
 *   Home/End move, Enter/Space toggle the highlighted option, Esc closes the
 *   dropdown only (never the surrounding dialog), Tab closes it.
 * - Click outside closes; scroll/resize repositions or closes the panel.
 * - Disabled options cannot be added but a selected disabled option can still
 *   be removed; `max` blocks adding beyond the limit.
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
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { Avatar } from "./Avatar";
import { cn } from "../lib/utils";
import "./MultiSelect.css";

export interface MultiSelectOption {
  value: string;
  label: string;
  /** Secondary line, usually the member title / duty. */
  description?: string;
  /** Real avatar image URL (members / assignees) rendered in trigger & list. */
  avatar?: string;
  /** Avatar base colour (falls back to the shared avatar default). */
  color?: string;
  /** Disabled options cannot be added. A selected disabled row can be removed. */
  disabled?: boolean;
  /** Small hint rendered for disabled rows (defaults to "不可选"). */
  disabledHint?: string;
}

export interface MultiSelectProps {
  value: string[];
  onChange: (value: string[]) => void;
  options: MultiSelectOption[];
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
  searchable?: boolean;
  /** Maximum number of values (undefined = unlimited). */
  max?: number;
  /** Copy shown when the filtered option list is empty. */
  emptyLabel?: string;
  id?: string;
  name?: string;
}

const PANEL_GAP = 6;
const PANEL_EDGE = 8;
const PANEL_MAX_HEIGHT = 340;
const PANEL_MIN_WIDTH = 220;
const OPEN_SCROLL_GRACE_MS = 260;

const isBlocked = (option: MultiSelectOption, selected: boolean, atLimit: boolean): boolean =>
  !selected && (option.disabled || atLimit);

function firstEnabledIndex(
  list: MultiSelectOption[],
  from: number,
  direction: 1 | -1,
  selectedValues: string[],
  atLimit: boolean,
): number {
  if (!list.length) return -1;
  let index = from;
  for (let step = 0; step < list.length; step += 1) {
    index = (index + direction + list.length) % list.length;
    const option = list[index];
    if (!option) continue;
    // A selected option stays focusable so it can always be removed, even when
    // it is disabled (e.g. it is the current primary owner).
    if (selectedValues.includes(option.value)) return index;
    if (!option.disabled && !atLimit) return index;
  }
  return -1;
}

function filterOptions(options: MultiSelectOption[], query: string): MultiSelectOption[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return options;
  return options.filter((option) => {
    const haystack = `${option.label} ${option.description ?? ""}`.toLowerCase();
    return haystack.includes(keyword);
  });
}

export function MultiSelect({
  value,
  onChange,
  options,
  placeholder = "请选择",
  ariaLabel,
  disabled = false,
  className,
  size = "md",
  searchable = true,
  max,
  emptyLabel = "没有匹配的成员",
  id,
  name,
}: MultiSelectProps) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const openedAtRef = useRef(0);
  const reactId = useId();
  const listId = `ts-multiselect-list-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const optionId = (index: number) => `${listId}-option-${index}`;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [query, setQuery] = useState("");
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const [isTop, setIsTop] = useState(false);

  const atLimit = max !== undefined && value.length >= max;
  const selectedSet = useMemo(() => new Set(value), [value]);
  const optionMap = useMemo(
    () => new Map(options.map((option) => [option.value, option])),
    [options],
  );
  /* Preserve the caller's order (the editor owns the backup order). */
  const selectedOptions = useMemo(
    () =>
      value
        .map((selectedValue) => optionMap.get(selectedValue))
        .filter((option): option is MultiSelectOption => Boolean(option)),
    [optionMap, value],
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
    const selectedIndex = options.findIndex(
      (option) => selectedSet.has(option.value) && !option.disabled,
    );
    setQuery("");
    setActiveIndex(
      selectedIndex >= 0
        ? selectedIndex
        : firstEnabledIndex(options, -1, 1, value, atLimit),
    );
    openedAtRef.current = Date.now();
    setOpen(true);
  }, [atLimit, disabled, options, selectedSet, value]);

  /* ---------------------------------------------------------------- */
  /* Positioning: fixed coordinates relative to the trigger button.    */
  /* ---------------------------------------------------------------- */
  const computePanelPosition = useCallback(() => {
    const trigger = triggerButtonRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const width = Math.min(Math.max(rect.width, PANEL_MIN_WIDTH), viewportWidth - PANEL_EDGE * 2);
    const left = Math.min(
      Math.max(PANEL_EDGE, rect.left),
      Math.max(PANEL_EDGE, viewportWidth - width - PANEL_EDGE),
    );
    const estimatedHeight = Math.min(
      (searchable ? 44 : 0) + Math.max(filtered.length, 1) * 42 + 34,
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

  /* Clamp the highlight when the option set / selection state changes. */
  useEffect(() => {
    if (!open) return;
    setActiveIndex((current) => {
      if (!filtered.length) return -1;
      const currentOption = current >= 0 ? filtered[current] : undefined;
      if (currentOption && !isBlocked(currentOption, selectedSet.has(currentOption.value), atLimit)) {
        return current;
      }
      return firstEnabledIndex(filtered, -1, 1, value, atLimit);
    });
  }, [open, filtered, selectedSet, atLimit, value]);

  const toggleOption = useCallback(
    (option: MultiSelectOption) => {
      const selected = value.includes(option.value);
      if (!selected && (option.disabled || atLimit)) return;
      const next = selected
        ? value.filter((current) => current !== option.value)
        : [...value, option.value];
      onChange(next);
    },
    [atLimit, onChange, value],
  );

  const moveActive = useCallback(
    (direction: 1 | -1) => {
      setActiveIndex((current) => firstEnabledIndex(filtered, current, direction, value, atLimit));
    },
    [atLimit, filtered, value],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (disabled) return;
      const fromSearch = event.target === searchRef.current;
      const target = event.target as HTMLElement | null;
      const fromActionButton =
        target instanceof HTMLButtonElement && Boolean(target.closest(".ts-multiselect-footer"));
      if (fromActionButton && (event.key === "Enter" || event.key === " ")) return;
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
          setActiveIndex(firstEnabledIndex(filtered, -1, 1, value, atLimit));
          break;
        case "End":
          if (!open) return;
          event.preventDefault();
          setActiveIndex(firstEnabledIndex(filtered, 0, -1, value, atLimit));
          break;
        case "Enter": {
          event.preventDefault();
          if (!open) {
            openPanel();
            break;
          }
          const option = filtered[activeIndex];
          if (option) toggleOption(option);
          break;
        }
        case " ":
          if (fromSearch) break;
          if (!open) break; // native button click opens the panel
          event.preventDefault();
          if (filtered[activeIndex]) toggleOption(filtered[activeIndex]);
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
        default:
          break;
      }
    },
    [
      activeIndex,
      atLimit,
      closePanel,
      disabled,
      filtered,
      moveActive,
      open,
      openPanel,
      toggleOption,
      value,
    ],
  );

  const handleSearchChange = (next: string) => {
    setQuery(next);
    setActiveIndex(firstEnabledIndex(filterOptions(options, next), -1, 1, value, atLimit));
  };

  const handleTriggerClick = () => {
    if (disabled) return;
    if (open) closePanel();
    else openPanel();
  };

  /* Compact summary in the trigger: two avatar chips + "+N". */
  const chipLimit = size === "sm" ? 1 : 2;
  const visibleChips = selectedOptions.slice(0, chipLimit);
  const hiddenChipCount = value.length - visibleChips.length;
  const triggerTitle = selectedOptions.length
    ? selectedOptions.map((option) => option.label).join("、")
    : undefined;

  const activeOption = open && activeIndex >= 0 ? filtered[activeIndex] : undefined;
  const activeOptionId = activeOption ? optionId(activeIndex) : undefined;

  return (
    <div
      ref={triggerRef}
      className={cn(
        "ts-multiselect",
        `ts-multiselect-${size}`,
        open && "is-open",
        disabled && "is-disabled",
        max !== undefined && "has-max",
        className,
      )}
    >
      <button
        ref={triggerButtonRef}
        type="button"
        id={id}
        className="ts-multiselect-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={activeOptionId}
        aria-label={ariaLabel}
        title={triggerTitle}
        disabled={disabled}
        onClick={handleTriggerClick}
        onKeyDown={handleKeyDown}
      >
        {selectedOptions.length || hiddenChipCount > 0 ? (
          <span className="ts-multiselect-value">
            {visibleChips.map((option) => (
              <span key={option.value} className="ts-multiselect-chip" title={option.label}>
                <Avatar
                  name={option.label}
                  src={option.avatar}
                  color={option.color}
                  size="xs"
                />
                <span className="ts-multiselect-chip-label">{option.label}</span>
              </span>
            ))}
            {hiddenChipCount > 0 ? (
              <span
                className="ts-multiselect-chip is-more"
                title={selectedOptions
                  .slice(visibleChips.length)
                  .map((option) => option.label)
                  .join("、")}
              >
                +{hiddenChipCount}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="ts-multiselect-placeholder">{placeholder}</span>
        )}
        <ChevronsUpDown size={14} className="ts-multiselect-caret" aria-hidden="true" />
      </button>
      {name ? <input type="hidden" name={name} value={value.join(",")} /> : null}

      {open
        ? createPortal(
            <div
              ref={panelRef}
              className={cn("ts-multiselect-panel", isTop && "is-top")}
              style={panelStyle}
              onKeyDown={handleKeyDown}
            >
              {searchable ? (
                <div className="ts-multiselect-search">
                  <Search size={13} aria-hidden="true" />
                  <input
                    ref={searchRef}
                    className="ts-multiselect-search-input"
                    value={query}
                    placeholder="搜索成员…"
                    aria-label={ariaLabel ? `${ariaLabel}：搜索选项` : "搜索选项"}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={open}
                    aria-controls={listId}
                    aria-activedescendant={activeOptionId}
                    onChange={(event) => handleSearchChange(event.target.value)}
                  />
                </div>
              ) : null}

              <ul
                ref={listRef}
                id={listId}
                className="ts-multiselect-list"
                role="listbox"
                aria-multiselectable="true"
                aria-label={ariaLabel ?? placeholder}
              >
                {filtered.length ? (
                  filtered.map((option, index) => {
                    const selected = selectedSet.has(option.value);
                    const blocked = isBlocked(option, selected, atLimit);
                    return (
                      <li
                        key={`${option.value}-${index}`}
                        id={optionId(index)}
                        data-option-index={index}
                        role="option"
                        aria-selected={selected}
                        aria-disabled={blocked || undefined}
                        className={cn(
                          "ts-multiselect-option",
                          index === activeIndex && "is-active",
                          selected && "is-selected",
                          blocked && "is-blocked",
                        )}
                        title={
                          option.disabled
                            ? option.disabledHint ?? "该成员不可选"
                            : option.description
                        }
                        onMouseDown={(event) => {
                          // Avoid stealing focus from the search box / trigger.
                          event.preventDefault();
                          if (!blocked) setActiveIndex(index);
                        }}
                        onMouseEnter={() => {
                          if (!blocked) setActiveIndex(index);
                        }}
                        onClick={() => toggleOption(option)}
                      >
                        <span
                          className={cn("ts-multiselect-check", selected && "is-checked")}
                          aria-hidden="true"
                        >
                          {selected ? <Check size={11} /> : null}
                        </span>
                        <Avatar
                          name={option.label}
                          src={option.avatar}
                          color={option.color}
                          size="xs"
                        />
                        <span className="ts-multiselect-option-main">
                          <span className="ts-multiselect-option-label">{option.label}</span>
                          {option.description ? (
                            <span className="ts-multiselect-option-desc">{option.description}</span>
                          ) : null}
                        </span>
                        {option.disabled ? (
                          <span className="ts-multiselect-option-tag">
                            {selected ? "点按移除" : option.disabledHint ?? "不可选"}
                          </span>
                        ) : null}
                      </li>
                    );
                  })
                ) : (
                  <li className="ts-multiselect-empty">{emptyLabel}</li>
                )}
              </ul>

              <div className="ts-multiselect-footer">
                <span>
                  已选 <b>{value.length}</b>
                  {max !== undefined ? ` / ${max} 项` : " 项"}
                  {atLimit ? " · 已达上限" : ""}
                </span>
                <span className="ts-multiselect-footer-actions">
                  {value.length ? (
                    <button
                      type="button"
                      className="ts-multiselect-clear"
                      onClick={() => {
                        onChange([]);
                        searchRef.current?.focus();
                      }}
                    >
                      <X size={11} aria-hidden="true" /> 清空
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="ts-multiselect-done"
                    onClick={() => {
                      closePanel();
                      triggerButtonRef.current?.focus();
                    }}
                  >
                    完成
                  </button>
                </span>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export default MultiSelect;
