"use client";

import React, { useState } from "react";
import { ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import Reveal from "./Reveal";

const faqs = [
  {
    question: "How does escrow work on StellarMarket?",
    answer:
      "When a client funds a job, the budget is locked in a Soroban smart contract on the Stellar network — not held by StellarMarket. Funds only release to the freelancer when the client approves a milestone, or automatically if a dispute is resolved in the freelancer's favor.",
  },
  {
    question: "What happens if a client and freelancer disagree?",
    answer:
      "Either party can open a dispute. A panel of independent arbitrators reviews the evidence and votes on a resolution on-chain, so no single party — including StellarMarket — controls the outcome.",
  },
  {
    question: "Do I need a Stellar wallet to use StellarMarket?",
    answer:
      "Yes. Connecting a Stellar wallet (like Freighter) lets you fund escrow, receive payments, and sign on-chain actions. You can browse jobs and freelancer profiles without one, but you'll need a wallet to post a job, apply, or get paid.",
  },
  {
    question: "How is on-chain reputation calculated?",
    answer:
      "Every completed job and review is recorded on-chain. Your reputation score factors in your average rating, review volume, and stake, and decays gradually over time so it always reflects recent, active work rather than a one-time high score.",
  },
  {
    question: "What fees does StellarMarket charge?",
    answer:
      "StellarMarket takes a small percentage fee from each milestone payment, deducted automatically by the smart contract when funds release — there are no separate invoices or manual payouts to manage.",
  },
];

function FAQItem({
  question,
  answer,
  isOpen,
  onToggle,
}: {
  question: string;
  answer: string;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="card overflow-hidden">
      <button
        onClick={onToggle}
        aria-expanded={isOpen}
        className="w-full flex items-center justify-between gap-4 text-left active:scale-[0.98] transition-transform duration-150"
      >
        <span className="font-semibold text-theme-heading">{question}</span>
        <ChevronDown
          size={18}
          className={`shrink-0 text-theme-text transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
        />
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <p className="text-sm text-theme-text pt-4">{answer}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function FAQSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section className="border-t border-theme-border py-20 bg-theme-bg">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <Reveal>
          <h2 className="text-3xl font-bold text-theme-heading text-center mb-12">
            Frequently Asked Questions
          </h2>
        </Reveal>
        <div className="space-y-4">
          {faqs.map((faq, index) => (
            <Reveal key={faq.question} delay={index * 0.05}>
              <FAQItem
                question={faq.question}
                answer={faq.answer}
                isOpen={openIndex === index}
                onToggle={() => setOpenIndex(openIndex === index ? null : index)}
              />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
