"use client";

import { Modal } from "./Modal";

interface ComingSoonProps {
  /** Feature name to display, e.g. "Settings" or "Microsoft Graph". null = closed. */
  feature: string | null;
  description?: string;
  onClose: () => void;
}

export function ComingSoon({ feature, description, onClose }: ComingSoonProps) {
  return (
    <Modal open={feature !== null} onClose={onClose} title={feature ?? ""}>
      <p className="leading-relaxed">
        {description ??
          `${feature} isn't built yet. It's on the roadmap — check back soon.`}
      </p>
    </Modal>
  );
}
