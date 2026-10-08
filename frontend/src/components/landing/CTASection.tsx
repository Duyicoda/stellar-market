"use client";

import React from "react";
import Link from "next/link";
import { ArrowRight, LayoutDashboard } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import Reveal from "./Reveal";

export default function CTASection() {
  const { user } = useAuth();

  return (
    <section className="border-t border-theme-border py-20 bg-gradient-to-b from-theme-bg to-theme-card">
      <Reveal className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <h2 className="text-4xl font-bold text-theme-heading mb-6">
          Ready to join the future of work?
        </h2>
        <p className="text-xl text-theme-text mb-10 max-w-2xl mx-auto">
          Start building your on-chain reputation today. Whether you are hiring
          top talent or looking for your next big project, StellarMarket is the
          place to be.
        </p>

        {user ? (
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/dashboard" className="btn-primary flex items-center gap-2">
              <LayoutDashboard size={18} />
              Go to Dashboard
            </Link>
            <Link href="/jobs" className="btn-secondary">
              Browse Jobs
            </Link>
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/auth/register" className="btn-primary flex items-center gap-2">
              Get Started Now <ArrowRight size={18} />
            </Link>
            <Link href="/auth/login" className="btn-secondary">
              Log In
            </Link>
          </div>
        )}
      </Reveal>
    </section>
  );
}
