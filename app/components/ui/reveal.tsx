"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";

type RevealProps = {
  children: ReactNode;
  delay?: number;
  className?: string;
  /** Renders immediately with no entrance animation. Use for above-the-fold
   *  content, which is otherwise server-rendered at opacity 0 and stays
   *  invisible until IntersectionObserver fires after hydration. */
  immediate?: boolean;
};

export function Reveal({ children, delay = 0, className, immediate = false }: RevealProps) {
  if (immediate) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.7, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}
