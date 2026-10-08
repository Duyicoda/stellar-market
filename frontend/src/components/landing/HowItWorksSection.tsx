import React from "react";
import Reveal from "./Reveal";

export default function HowItWorksSection() {
  const steps = [
    { step: "01", title: "Post a Job", desc: "Describe your project, set milestones and budget" },
    { step: "02", title: "Get Applications", desc: "Review freelancer profiles and proposals" },
    { step: "03", title: "Escrow Funded", desc: "Funds locked in smart contract on acceptance" },
    { step: "04", title: "Work & Pay", desc: "Approve milestones to release payments" },
  ];

  return (
    <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 bg-theme-bg">
      <Reveal>
        <h2 className="text-3xl font-bold text-theme-heading text-center mb-12">
          How It Works
        </h2>
      </Reveal>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {steps.map((item, index) => (
          <Reveal key={item.step} delay={index * 0.1} hoverLift className="card text-center flex flex-col items-center">
            <div className="text-4xl font-bold bg-gradient-to-r from-stellar-blue to-stellar-purple bg-clip-text text-transparent mb-4">
              {item.step}
            </div>
            <h3 className="text-lg font-semibold text-theme-heading mb-2">
              {item.title}
            </h3>
            <p className="text-sm text-theme-text">{item.desc}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
