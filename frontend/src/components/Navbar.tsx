"use client";

import Link from "next/link";
import {
  Menu,
  X,
  MessageSquare,
  Briefcase,
  LayoutDashboard,
  PenLine,
  LogOut,
  User as UserIcon,
  Users,
  Settings,
  Search,
  ShieldCheck,
  Unplug,
  Wallet,
  Bookmark,
  ChevronDown,
  Loader2,
  RefreshCw,
  Gift,
  Monitor,
  Server,
  FileCode,
  Palette,
  Smartphone,
  FileText,
  Container,
  Grid3X3,
} from "lucide-react";
import Avatar from "./Avatar";
import axios from "axios";
import { useState, useRef, useEffect, type TouchEvent } from "react";
import { useWallet, truncateAddress } from "@/context/WalletContext";
import { useWalletBalance } from "@/hooks/useWalletBalance";
import { useSocket } from "@/context/SocketContext";
import { useAuth } from "@/context/AuthContext";
import { usePathname, useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import ThemeToggleButton from "./ThemeToggleButton";
import NotificationBell from "./NotificationBell";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5000/api/v1";

function UserMenu({ className }: { className?: string }) {
  const { address, disconnect, balance, balances, isLoadingBalance } = useWallet();
  const { user, logout, isLoading } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [balanceDropdownOpen, setBalanceDropdownOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const balanceRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { toast } = useToast();

  // Handle wallet disconnect events
  useEffect(() => {
    const handleWalletDisconnected = () => {
      toast.error("Wallet disconnected — please reconnect");
    };

    window.addEventListener("stellarmarket:walletDisconnected", handleWalletDisconnected);
    return () => {
      window.removeEventListener("stellarmarket:walletDisconnected", handleWalletDisconnected);
    };
  }, [toast]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
      if (balanceRef.current && !balanceRef.current.contains(e.target as Node)) {
        setBalanceDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  /** Disconnects Freighter wallet without ending the backend session. */
  const handleDisconnect = () => {
    disconnect();
    setMenuOpen(false);
    router.push("/");
  };

  if (isLoading) {
    return (
      <div
        className={`h-10 w-32 bg-theme-border/50 animate-pulse rounded-lg ${className ?? ""}`}
      />
    );
  }

  if (user) {
    return (
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className={`flex items-center gap-3 px-3 py-1.5 rounded-lg border border-theme-border hover:bg-theme-border/50 transition-colors ${className ?? ""}`}
        >
          <Avatar
            src={user.avatarUrl}
            alt={user.username}
            size={32}
            unoptimized
          />
          <div className="text-left hidden lg:block">
            <p className="text-sm font-medium text-theme-heading leading-tight">
              {user.username}
            </p>
            {/* Show live Freighter address when connected, else DB address */}
            <p className="text-xs text-theme-text leading-tight font-mono">
              {address ? truncateAddress(address) : user.role}
            </p>
          </div>
        </button>
        {menuOpen && (
          <div className="absolute right-0 mt-2 w-64 bg-theme-card border border-theme-border rounded-xl shadow-2xl py-2 z-50 animate-in fade-in slide-in-from-top-2">
            <div className="px-4 py-3 border-b border-theme-border mb-1">
              <p className="text-sm font-medium text-theme-heading">
                {user.username}
              </p>
              {/* Truncated Freighter address in header */}
              {address && (
                <p className="text-xs text-stellar-blue font-mono mt-0.5">
                  {truncateAddress(address)}
                </p>
              )}
              <p className="text-xs text-theme-text break-all mt-0.5">
                {user.walletAddress}
              </p>
            </div>
            <Link
              href={`/profile/${user.id}`}
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-2 px-4 py-2.5 text-sm text-theme-text hover:bg-theme-border/50 transition-colors"
            >
              <UserIcon size={16} />
              Your Profile
            </Link>
            <Link
              href="/dashboard"
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-2 px-4 py-2.5 text-sm text-theme-text hover:bg-theme-border/50 transition-colors"
            >
              <LayoutDashboard size={16} />
              Dashboard
            </Link>
            <Link
              href="/settings"
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-2 px-4 py-2.5 text-sm text-theme-text hover:bg-theme-border/50 transition-colors"
            >
              <Settings size={16} />
              Settings
            </Link>
            <Link
              href="/dashboard/referrals"
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-2 px-4 py-2.5 text-sm text-theme-text hover:bg-theme-border/50 transition-colors"
            >
              <Gift size={16} />
              Referrals
            </Link>

            {/* Wallet disconnect section — only shown when Freighter is connected */}
            {address && (
              <>
                <div className="border-t border-theme-border mx-2 my-1" />
                <button
                  onClick={handleDisconnect}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-theme-error hover:bg-theme-error/10 transition-colors text-left"
                  aria-label="Disconnect Freighter wallet"
                >
                  <Unplug size={16} />
                  Disconnect Wallet
                </button>
              </>
            )}

            <div className="border-t border-theme-border mx-2 my-1" />
            <button
              onClick={() => {
                logout();
                disconnect();
                setMenuOpen(false);
              }}
              className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-theme-error hover:bg-theme-error/10 transition-colors text-left"
            >
              <LogOut size={16} />
              Sign Out
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <Link
        href="/auth/login"
        className="text-sm font-medium text-theme-text hover:text-theme-heading transition-colors"
      >
        Log In
      </Link>
      <Link href="/auth/register" className="btn-primary text-sm py-2 px-4">
        Sign Up
      </Link>
    </div>
  );
}

/** Wallet balance display with dropdown for other assets */
function WalletBalanceDisplay() {
  const { address, connect, signMessage, bindWallet } = useWallet();
  const { user, token, login, refreshUser } = useAuth();
  const { toast } = useToast();
  // Cached via TanStack Query (30s stale-time + refetch-on-focus) so the header
  // balance is served from cache across renders/remounts instead of hitting
  // Horizon every time, and refreshes in the background on window focus.
  const { balances, isLoading, isRefreshing } = useWalletBalance(address);
  const xlmBalance = balances.find((b) => b.asset === "XLM");
  const balance = xlmBalance ? parseFloat(xlmBalance.balance).toFixed(2) : null;
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [newAccountConfirm, setNewAccountConfirm] = useState<string | null>(null);
  const [replaceWalletConfirm, setReplaceWalletConfirm] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const replaceConfirmRef = useRef<HTMLDivElement>(null);
  useFocusTrap(confirmRef, { open: !!newAccountConfirm, onClose: () => setNewAccountConfirm(null) });
  useFocusTrap(replaceConfirmRef, { open: !!replaceWalletConfirm, onClose: () => setReplaceWalletConfirm(null) });

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const signInWithWallet = async (connectedAddress: string) => {
    const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5000/api/v1";
    const message = `Sign in to StellarMarket with ${connectedAddress} at ${Date.now()}`;
    const signature = await signMessage(message);
    const response = await fetch(`${API}/auth/wallet/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey: connectedAddress, message, signature }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.message || "Wallet login failed");
    login(data.token, data.user);
    toast.success("Signed in with wallet.");
  };

  const linkWallet = async () => {
    if (!token) return;
    const result = await bindWallet(token);
    if (!result.success) {
      toast.error(result.error ?? "Failed to link wallet.");
      return;
    }
    if (result.token) {
      localStorage.setItem("stellarmarket_jwt", result.token);
    }
    await refreshUser();
    toast.success("Wallet linked to your account.");
  };

  // "Connect Wallet" used to only open the browser wallet extension and stop
  // there — it never created an account or logged anyone in, and for an
  // already logged-in user it never linked the address to their account
  // either, so clicking it looked like it did nothing. Now it completes the
  // action it advertises: signed out, it signs you in (or creates an
  // account, same as "Continue with wallet" on the login page); signed in,
  // it links the connected address to your account, same as Settings does.
  //
  // Before signing anyone in on a wallet that's never been seen, it checks
  // whether that would actually create a new account — someone who already
  // has an email account but never linked this wallet to it would otherwise
  // silently end up with a second, disconnected account with no way back to
  // the first one from here. Symmetrically, if the account already has a
  // *different* wallet linked, connecting a new one used to silently replace
  // it server-side (auth.routes.ts's /wallet/link only rejects a wallet
  // already claimed by someone else — it never checks whether this account
  // already had a different one) — now that's confirmed first too.
  const handleConnectClick = async () => {
    setConnecting(true);
    try {
      const connectedAddress = address ?? (await connect());
      if (!connectedAddress) return;

      if (!user) {
        const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5000/api/v1";
        const existsRes = await fetch(
          `${API}/auth/wallet/exists?address=${encodeURIComponent(connectedAddress)}`,
        );
        const { exists } = existsRes.ok
          ? ((await existsRes.json()) as { exists: boolean })
          : { exists: true }; // fail open to the normal login flow rather than block on a check failure
        if (!exists) {
          setNewAccountConfirm(connectedAddress);
          return;
        }
        await signInWithWallet(connectedAddress);
      } else if (!token) {
        return;
      } else if (user.walletAddress && user.walletAddress !== connectedAddress) {
        setReplaceWalletConfirm(connectedAddress);
        return;
      } else {
        await linkWallet();
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to connect wallet.");
    } finally {
      setConnecting(false);
    }
  };

  const handleConfirmReplaceWallet = async () => {
    setConnecting(true);
    try {
      await linkWallet();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to connect wallet.");
    } finally {
      setReplaceWalletConfirm(null);
      setConnecting(false);
    }
  };

  const handleConfirmNewAccount = async () => {
    if (!newAccountConfirm) return;
    setConnecting(true);
    try {
      await signInWithWallet(newAccountConfirm);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to connect wallet.");
    } finally {
      setNewAccountConfirm(null);
      setConnecting(false);
    }
  };

  const newAccountModal = newAccountConfirm && (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div ref={confirmRef} className="bg-theme-card border border-theme-border rounded-xl shadow-2xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-theme-heading mb-2">
          No account found for this wallet
        </h2>
        <p className="text-sm text-theme-text mb-6">
          This wallet isn&apos;t linked to any StellarMarket account yet. Continuing will{" "}
          <span className="font-medium text-theme-heading">create a brand new account</span> for it.
          If you already have an account, cancel, log in the normal way, then link this wallet from Settings instead.
        </p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={() => setNewAccountConfirm(null)}
            className="btn-secondary"
            disabled={connecting}
          >
            Cancel
          </button>
          <button
            onClick={() => void handleConfirmNewAccount()}
            disabled={connecting}
            className="btn-primary flex items-center gap-2 disabled:opacity-60"
          >
            {connecting ? <Loader2 size={14} className="animate-spin" /> : null}
            Create new account
          </button>
        </div>
      </div>
    </div>
  );

  const replaceWalletModal = replaceWalletConfirm && (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div ref={replaceConfirmRef} className="bg-theme-card border border-theme-border rounded-xl shadow-2xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-theme-heading mb-2">
          Replace your linked wallet?
        </h2>
        <p className="text-sm text-theme-text mb-6">
          Your account currently has{" "}
          <span className="font-mono text-theme-heading">{truncateAddress(user?.walletAddress ?? "")}</span>{" "}
          linked. Continuing will replace it with{" "}
          <span className="font-mono text-theme-heading">{truncateAddress(replaceWalletConfirm)}</span> — future
          payments will go to the new wallet, and the old one will no longer be linked to this account.
        </p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={() => setReplaceWalletConfirm(null)}
            className="btn-secondary"
            disabled={connecting}
          >
            Cancel
          </button>
          <button
            onClick={() => void handleConfirmReplaceWallet()}
            disabled={connecting}
            className="btn-primary flex items-center gap-2 disabled:opacity-60"
          >
            {connecting ? <Loader2 size={14} className="animate-spin" /> : null}
            Replace wallet
          </button>
        </div>
      </div>
    </div>
  );

  if (!address) {
    return (
      <>
        <button
          onClick={() => void handleConnectClick()}
          disabled={connecting}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-stellar-blue/50 text-stellar-blue hover:bg-stellar-blue/10 transition-colors text-sm font-medium disabled:opacity-60"
        >
          {connecting ? <Loader2 size={14} className="animate-spin" /> : <Wallet size={14} />}
          Connect Wallet
        </button>
        {newAccountModal}
        {replaceWalletModal}
      </>
    );
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setDropdownOpen(!dropdownOpen)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-theme-border hover:bg-theme-border/50 transition-colors text-sm"
        title={`Full balance: ${balance ?? "0.00"} XLM`}
      >
        {isLoading && balance === null ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <>
            <span className="font-medium text-theme-heading">{balance ?? "0.00"}</span>
            <span className="text-theme-text">XLM</span>
            {isRefreshing && (
              <RefreshCw
                size={12}
                className="animate-spin text-theme-text/60"
                aria-label="Refreshing balance"
                data-testid="balance-refreshing"
              />
            )}
            {balances.length > 1 && <ChevronDown size={14} className="text-theme-text" />}
          </>
        )}
      </button>

      {/* Dropdown for other balances */}
      {dropdownOpen && balances.length > 1 && (
        <div className="absolute right-0 mt-2 w-56 bg-theme-card border border-theme-border rounded-xl shadow-2xl py-2 z-50 animate-in fade-in slide-in-from-top-2">
          <div className="px-4 py-2 border-b border-theme-border mb-1">
            <p className="text-xs font-semibold text-theme-text uppercase">All Balances</p>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {balances.map((b) => (
              <div
                key={b.asset}
                className="flex items-center justify-between px-4 py-2.5 text-sm text-theme-text hover:bg-theme-border/50 transition-colors"
              >
                <span className="font-medium">{b.asset}</span>
                <span className="text-theme-heading">{parseFloat(b.balance).toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {newAccountModal}
      {replaceWalletModal}
    </div>
  );
}

/** Real-time unread badge powered by Socket.io + initial REST count */
function UnreadBadge() {
  const { socket } = useSocket();
  const { token } = useAuth();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!token) return;

    axios
      .get<{ count: number }>(`${API}/messages/unread-count`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((res) => setCount(res.data.count))
      .catch(() => {
        /* silently ignore */
      });
  }, [token]);

  useEffect(() => {
    if (!socket) return;

    const handleNewMessage = () => setCount((c) => c + 1);
    const handleMessagesRead = () => setCount(0);

    socket.on("new_message", handleNewMessage);
    socket.on("messages_read", handleMessagesRead);

    return () => {
      socket.off("new_message", handleNewMessage);
      socket.off("messages_read", handleMessagesRead);
    };
  }, [socket]);

  if (count === 0) return null;

  return (
    <span
      id="unread-badge"
      data-testid="unread-badge"
      className="absolute -top-1.5 -right-2.5 bg-stellar-blue text-white text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center shadow-lg border border-theme-bg animate-pulse"
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

export default function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileDrawerRef = useRef<HTMLDivElement>(null);
  const touchStartXRef = useRef<number | null>(null);
  const { user } = useAuth();
  const pathname = usePathname();
  const isClient = user?.role === "CLIENT";
  const isFreelancer = user?.role === "FREELANCER";

  const categories = [
    { slug: "frontend", label: "Frontend" },
    { slug: "backend", label: "Backend" },
    { slug: "smart-contract", label: "Smart Contract" },
    { slug: "design", label: "Design" },
    { slug: "mobile", label: "Mobile" },
    { slug: "documentation", label: "Documentation" },
    { slug: "devops", label: "DevOps" },
  ];

  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const categoriesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (categoriesRef.current && !categoriesRef.current.contains(e.target as Node)) {
        setCategoriesOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const navLinks = [
    { href: "/jobs", label: isFreelancer ? "Find Work" : "Jobs", icon: Briefcase, hide: isClient },
    { href: "/saved-jobs", label: "Saved Jobs", icon: Bookmark, hide: !isFreelancer && !isClient },
    { href: "/services", label: "Services", icon: Search },
    { href: "/freelancers", label: "Talent", icon: Users },
    { href: "/disputes", label: "Disputes", icon: ShieldCheck },
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/messages", label: "Messages", icon: MessageSquare, id: "messages-nav-link" },
    { href: "/wallet", label: "Wallet", icon: Wallet },
  ];

  if (isClient) {
    navLinks.push({ href: "/post-job", label: "Post a Job", icon: PenLine });
  }

  const isActive = (path: string) => {
    if (path === "/" && pathname !== "/") return false;
    return pathname?.startsWith(path);
  };

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) {
      document.body.style.overflow = "";
      return;
    }

    document.body.style.overflow = "hidden";

    const drawer = mobileDrawerRef.current;
    const focusableSelectors = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(", ");

    const focusableElements = Array.from(
      drawer?.querySelectorAll<HTMLElement>(focusableSelectors) ?? [],
    );
    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];

    firstFocusable?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileOpen(false);
        return;
      }

      if (event.key !== "Tab" || focusableElements.length === 0) return;

      if (event.shiftKey) {
        if (document.activeElement === firstFocusable) {
          event.preventDefault();
          lastFocusable?.focus();
        }
        return;
      }

      if (document.activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    touchStartXRef.current = event.touches[0]?.clientX ?? null;
  };

  const handleTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    if (touchStartXRef.current === null) return;
    const touchEndX = event.changedTouches[0]?.clientX ?? touchStartXRef.current;
    const deltaX = touchEndX - touchStartXRef.current;
    touchStartXRef.current = null;

    if (deltaX < -60) {
      setMobileOpen(false);
    }
  };

  return (
    <nav className="border-b border-theme-border bg-theme-bg/80 backdrop-blur-md sticky top-0 z-50">
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <Link href="/" className="flex items-center gap-2 group shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element -- next/image blocks local SVGs without dangerouslyAllowSVG */}
            <img
              src="/favicon.svg"
              alt="StellarMarket"
              width={32}
              height={32}
              className="w-8 h-8 group-hover:scale-110 transition-transform"
            />
            <span className="text-xl font-bold text-theme-heading hidden sm:inline">
              StellarMarket
            </span>
          </Link>

          {/* Nav links: its own scrollable lane so a tight viewport never
              pushes into the logo or the right-side controls — it shrinks
              and, as a last resort, scrolls horizontally instead of
              colliding with its neighbors. */}
          <div className="hidden md:flex items-center justify-center gap-1 flex-1 min-w-0 overflow-x-auto px-2">
            {navLinks.filter(l => !l.hide).map((link) => (
              <Link
                key={link.href}
                href={link.href}
                id={link.id}
                title={link.label}
                className={`shrink-0 transition-colors flex items-center gap-2 text-sm font-medium px-2.5 py-1.5 rounded-lg ${
                  isActive(link.href)
                    ? "text-stellar-blue bg-stellar-blue/10"
                    : "text-theme-text hover:text-theme-heading hover:bg-theme-border/50"
                }`}
              >
                <link.icon size={16} />
                <span className="sr-only">{link.label}</span>
                {link.href === "/messages" && <UnreadBadge />}
              </Link>
            ))}

            {/* Categories Dropdown */}
            <div className="relative shrink-0" ref={categoriesRef}>
              <button
                onClick={() => setCategoriesOpen(!categoriesOpen)}
                title="Categories"
                className={`transition-colors flex items-center gap-2 text-sm font-medium px-2.5 py-1.5 rounded-lg ${
                  pathname?.startsWith("/category")
                    ? "text-stellar-blue bg-stellar-blue/10"
                    : "text-theme-text hover:text-theme-heading hover:bg-theme-border/50"
                }`}
              >
                <Grid3X3 size={16} />
                <span className="sr-only">Categories</span>
                <ChevronDown size={12} />
              </button>
              {categoriesOpen && (
                <div className="absolute left-0 mt-2 w-52 bg-theme-card border border-theme-border rounded-xl shadow-2xl py-2 z-50 animate-in fade-in slide-in-from-top-2">
                  {categories.map((cat) => (
                    <Link
                      key={cat.slug}
                      href={`/category/${cat.slug}`}
                      onClick={() => setCategoriesOpen(false)}
                      className={`flex items-center gap-2 px-4 py-2.5 text-sm transition-colors ${
                        pathname === `/category/${cat.slug}`
                          ? "text-stellar-blue bg-stellar-blue/5"
                          : "text-theme-text hover:bg-theme-border/50"
                      }`}
                    >
                      {cat.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right-side controls: never shrinks or gets scrolled offscreen —
              auth/wallet actions must always stay reachable. */}
          <div className="hidden md:flex items-center gap-3 shrink-0">
            <NotificationBell />
            <ThemeToggleButton />
            <WalletBalanceDisplay />
            <UserMenu />
          </div>

          <button
            className="md:hidden text-theme-text"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={mobileOpen}
            aria-controls="mobile-navigation-drawer"
          >
            {mobileOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>

        {/* Mobile Drawer */}
        <div
          className={`fixed inset-0 z-50 md:hidden transition-opacity duration-300 ${
            mobileOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
          }`}
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          
          {/* Panel */}
          <div
            id="mobile-navigation-drawer"
            ref={mobileDrawerRef}
            className={`absolute right-0 top-0 h-full w-72 bg-theme-bg border-l border-theme-border p-6 shadow-2xl transition-transform duration-300 ease-in-out outline-none ${
              mobileOpen ? "translate-x-0" : "translate-x-full"
            }`}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="Mobile navigation"
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          >
            {/* Close Button */}
            <div className="flex justify-between items-center mb-10">
              <span className="text-lg font-bold text-theme-heading">Menu</span>
              <button onClick={() => setMobileOpen(false)} className="p-2 text-theme-text hover:text-theme-heading" aria-label="Close navigation menu">
                <X size={24} />
              </button>
            </div>
            
            <div className="flex flex-col gap-2">
              {navLinks.filter(l => !l.hide).map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileOpen(false)}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${
                    isActive(link.href)
                      ? "bg-stellar-blue/10 text-stellar-blue font-bold shadow-sm"
                      : "text-theme-text hover:bg-theme-border/30"
                  }`}
                >
                  <link.icon size={20} />
                  <span>{link.label}</span>
                  {link.href === "/messages" && <UnreadBadge />}
                </Link>
              ))}
              {/* Mobile Categories */}
              <div className="mt-2 pt-2 border-t border-theme-border">
                <p className="px-4 py-2 text-xs font-semibold text-theme-text uppercase tracking-wider">
                  Categories
                </p>
                {categories.map((cat) => (
                  <Link
                    key={cat.slug}
                    href={`/category/${cat.slug}`}
                    onClick={() => setMobileOpen(false)}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-sm ${
                      pathname === `/category/${cat.slug}`
                        ? "bg-stellar-blue/10 text-stellar-blue font-bold"
                        : "text-theme-text hover:bg-theme-border/30"
                    }`}
                  >
                    {cat.label}
                  </Link>
                ))}
              </div>
            </div>

            <div className="mt-auto pt-8 border-t border-theme-border">
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between px-4">
                  <span className="text-sm font-medium text-theme-text">Notifications</span>
                  <NotificationBell />
                </div>
                <div className="flex items-center justify-between px-4">
                  <span className="text-sm font-medium text-theme-text">Theme</span>
                  <ThemeToggleButton />
                </div>
                <div className="mt-4">
                  <UserMenu className="w-full justify-between" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
}
