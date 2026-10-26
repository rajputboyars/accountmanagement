"use client";

import { motion } from "motion/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0 },
};

export function Hero() {
  return (
    <section className="relative flex min-h-svh items-center overflow-hidden px-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_50%_at_50%_0%,color-mix(in_oklch,var(--primary)_14%,transparent),transparent)]"
      />
      <motion.div
        initial="hidden"
        animate="show"
        transition={{ staggerChildren: 0.12 }}
        className="mx-auto flex w-full max-w-5xl flex-col items-start gap-8"
      >
        <motion.div variants={fadeUp} transition={{ duration: 0.6, ease: "easeOut" }}>
          <Badge variant="secondary">Next.js · shadcn/ui · Motion · GSAP</Badge>
        </motion.div>
        <motion.h1
          variants={fadeUp}
          transition={{ duration: 0.7, ease: "easeOut" }}
          className="text-5xl font-semibold leading-[0.95] tracking-tighter text-balance sm:text-7xl md:text-8xl"
        >
          Account management,
          <br />
          <span className="text-muted-foreground">built to move.</span>
        </motion.h1>
        <motion.p
          variants={fadeUp}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className="max-w-xl text-lg leading-relaxed text-muted-foreground"
        >
          A clean starting point. Edit{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground">
            src/components/sections/hero.tsx
          </code>{" "}
          to begin, then add the next section.
        </motion.p>
        <motion.div
          variants={fadeUp}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className="flex flex-wrap gap-3"
        >
          <Button size="lg">Get started</Button>
          <Button size="lg" variant="outline">
            Documentation
          </Button>
        </motion.div>
      </motion.div>
    </section>
  );
}
