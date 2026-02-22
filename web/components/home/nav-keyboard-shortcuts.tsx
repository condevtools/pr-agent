"use client";

import { useEffect } from "react";

const KEY_TO_SECTION: Record<string, string> = {
  a: "overview",
  b: "capabilities",
  c: "commands",
  d: "mermaid",
  e: "operations",
  f: "contact",
};

export function NavKeyboardShortcuts() {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }

      const section = KEY_TO_SECTION[event.key.toLowerCase()];
      if (section) {
        const element = document.getElementById(section);
        if (element) {
          element.scrollIntoView({ behavior: "smooth" });
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return null;
}
