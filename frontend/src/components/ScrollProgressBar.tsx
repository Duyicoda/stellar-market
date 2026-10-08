"use client";

import { motion, useScroll, useSpring } from "framer-motion";

/** Thin gradient bar under the navbar that fills as the page is scrolled. */
export default function ScrollProgressBar() {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, {
    stiffness: 300,
    damping: 40,
    restDelta: 0.001,
  });

  return (
    <motion.div
      className="fixed top-16 left-0 right-0 h-0.5 origin-left bg-gradient-to-r from-stellar-blue to-stellar-purple z-40"
      style={{ scaleX }}
    />
  );
}
