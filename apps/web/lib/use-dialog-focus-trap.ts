"use client";

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface DialogFocusTrapOptions {
  active: boolean;
  dialogRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onEscape: () => void;
}

/** Keeps first-run dialogs isolated from the mounted chat shell. */
export function useDialogFocusTrap({
  active,
  dialogRef,
  initialFocusRef,
  onEscape,
}: DialogFocusTrapOptions) {
  const openerRef = useRef<HTMLElement | null>(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;

    const current = document.activeElement;
    openerRef.current =
      current instanceof HTMLElement && current !== document.body
        ? current
        : null;

    const appShell = document.querySelector<HTMLElement>(
      '[data-app-shell="true"]',
    );
    const appShellWasInert = appShell?.hasAttribute("inert") ?? false;
    appShell?.setAttribute("inert", "");

    const dialog = dialogRef.current;
    const focusFrame = window.requestAnimationFrame(() => {
      const firstFocusable = dialog
        ?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (initialFocusRef?.current ?? firstFocusable ?? dialog)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleKeyDown, true);
      if (!appShellWasInert) appShell?.removeAttribute("inert");
      window.requestAnimationFrame(() => {
        const opener = openerRef.current;
        if (opener?.isConnected) opener.focus();
      });
    };
  }, [active, dialogRef, initialFocusRef]);
}
