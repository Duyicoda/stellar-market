import React from "react";
import HeroSection from "@/components/landing/HeroSection";
import StatsSection from "@/components/landing/StatsSection";
import HowItWorksSection from "@/components/landing/HowItWorksSection";
import FeaturedJobsCarousel from "@/components/landing/FeaturedJobsCarousel";
import FAQSection from "@/components/landing/FAQSection";
import CTASection from "@/components/landing/CTASection";

export const metadata = {
  title: "StellarMarket — Decentralized Freelance Marketplace",
  description:
    "The decentralized freelance marketplace built on Stellar. Escrow payments, on-chain reputation, and trustless dispute resolution.",
};

export default function Home() {
  return (
    <div className="flex flex-col">
      <HeroSection />
      <StatsSection />
      <HowItWorksSection />
      <FeaturedJobsCarousel />
      <FAQSection />
      <CTASection />
    </div>
  );
}
