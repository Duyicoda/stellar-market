"use client";

import React from "react";
import { motion } from "framer-motion";

interface RevealProps {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  /** Lifts the element on hover — use for cards that feel like a unit. */
  hoverLift?: boolean;
}

/** Fades and slides a section up into place the first time it scrolls into view. */
export default function Reveal({ children, className, delay = 0, hoverLift = false }: RevealProps) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 56, scale: 0.94 }}
      whileInView={{ opacity: 1, y: 0, scale: 1 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.7, delay, ease: [0.21, 0.47, 0.32, 0.98] }}
      {...(hoverLift
        ? { whileHover: { y: -6, transition: { duration: 0.2 } } }
        : {})}
    >
      {children}
    </motion.div>
  );
}
