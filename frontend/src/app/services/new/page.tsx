"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Plus, Loader2, Tag } from "lucide-react";
import axios from "axios";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/Toast";
import { SERVICE_CATEGORIES } from "@/constants/services";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api/v1";
const categories = SERVICE_CATEGORIES;
const STORAGE_KEY = "service-form-draft";

export default function NewServicePage() {
  const router = useRouter();
  // Destructure `token` from useAuth() so the Authorization header uses the
  // correct key (stellarmarket_jwt) rather than reading the non-existent
  // localStorage key "token" (issue #950).  token is null when not logged in,
  // which matches the original guard behaviour.
  const { user, isLoading, token } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [formData, setFormData] = useState({
    title: "",
    description: "",
    price: "",
    deliveryDays: "",
    category: "",
  });

  // Access control: redirect non-freelancers
  useEffect(() => {
    if (!isLoading && user !== null && user.role !== "FREELANCER") {
      toast.error("Only freelancers can post services. Switch your role in Settings.");
      router.replace("/services");
    }
  }, [isLoading, user, router, toast]);

  // Restore draft from localStorage
  useEffect(() => {
    const draft = localStorage.getItem(STORAGE_KEY);
    if (draft) {
      try {
        const parsed = JSON.parse(draft);
        if (parsed && typeof parsed === "object") {
          setFormData((prev) => ({ ...prev, ...parsed }));
        }
      } catch {}
    }
  }, []);

  // Persist draft to localStorage on change
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(formData));
  }, [formData]);

  // Show loading state while checking auth
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="animate-spin text-stellar-blue" size={48} />
      </div>
    );
  }

  // Redirect if not a freelancer
  if (user?.role !== "FREELANCER") {
    return null;
  }

  // Client-side validation
  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    const title = formData.title.trim();
    if (!title) {
      newErrors.title = "Title is required";
    } else if (title.length < 5) {
      newErrors.title = "Title must be at least 5 characters long";
    } else if (title.length > 200) {
      newErrors.title = "Title must be less than 200 characters";
    }

    const description = formData.description.trim();
    if (!description) {
      newErrors.description = "Description is required";
    } else if (description.length < 20) {
      newErrors.description = "Description must be at least 20 characters long";
    } else if (description.length > 5000) {
      newErrors.description = "Description must be less than 5000 characters";
    }

    if (!formData.category) {
      newErrors.category = "Category is required";
    }

    if (!formData.price) {
      newErrors.price = "Price is required";
    } else if (parseFloat(formData.price) <= 0) {
      newErrors.price = "Price must be greater than 0";
    }

    if (!formData.deliveryDays) {
      newErrors.deliveryDays = "Delivery days is required";
    } else if (parseInt(formData.deliveryDays) <= 0 || !Number.isInteger(parseFloat(formData.deliveryDays))) {
      newErrors.deliveryDays = "Delivery days must be a positive integer";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validate form before submission
    if (!validateForm()) {
      return;
    }

    setLoading(true);
    setErrors({});

    try {
      await axios.post(
        `${API_URL}/services`,
        {
          title: formData.title,
          description: formData.description,
          price: parseFloat(formData.price),
          deliveryDays: parseInt(formData.deliveryDays),
          category: formData.category,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      toast.success("Service created successfully!");
      localStorage.removeItem(STORAGE_KEY);
      router.push("/services");
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const errorMessage = err.response?.data?.error || "Failed to create service listing.";
        toast.error(errorMessage);
        setErrors({ submit: errorMessage });
      } else {
        toast.error("An unexpected error occurred.");
        setErrors({ submit: "An unexpected error occurred." });
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <h1 className="text-3xl font-bold text-theme-heading mb-2">Post a Service</h1>
      <p className="text-theme-text mb-8">
        Showcase your expertise and get discovered by clients across the platform.
      </p>

      <form onSubmit={handleSubmit} className="space-y-6">
        {errors.submit && (
          <div className="p-3 rounded-lg bg-theme-error/10 border border-theme-error/20 text-theme-error text-sm">
            {errors.submit}
          </div>
        )}

        {/* Title */}
        <div>
          <label className="block text-sm font-medium text-theme-heading mb-2">
            Service Title
          </label>
          <input
            type="text"
            required
            placeholder="e.g., Professional Soroban Smart Contract Development"
            className={`input-field ${errors.title ? "border-theme-error" : ""}`}
            value={formData.title}
            onChange={(e) => {
              setFormData({ ...formData, title: e.target.value });
              if (errors.title) setErrors({ ...errors, title: "" });
            }}
          />
          {errors.title && (
            <p className="mt-1 text-sm text-theme-error">{errors.title}</p>
          )}
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-theme-heading mb-2">
            Description
          </label>
          <textarea
            required
            rows={6}
            placeholder="Detailed description of what you offer, your process, and deliverables..."
            className={`input-field resize-none ${errors.description ? "border-theme-error" : ""}`}
            value={formData.description}
            onChange={(e) => {
              setFormData({ ...formData, description: e.target.value });
              if (errors.description) setErrors({ ...errors, description: "" });
            }}
          />
          {errors.description && (
            <p className="mt-1 text-sm text-theme-error">{errors.description}</p>
          )}
        </div>

        {/* Category */}
        <div>
          <label className="block text-sm font-medium text-theme-heading mb-2">
            Category
          </label>
          <select
            required
            className={`input-field cursor-pointer ${errors.category ? "border-theme-error" : ""}`}
            value={formData.category}
            onChange={(e) => {
              setFormData({ ...formData, category: e.target.value });
              if (errors.category) setErrors({ ...errors, category: "" });
            }}
          >
            <option value="">Select a category</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
          {errors.category && (
            <p className="mt-1 text-sm text-theme-error">{errors.category}</p>
          )}
        </div>

        {/* Price and Delivery Days */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-theme-heading mb-2">
              Price (XLM)
            </label>
            <input
              type="number"
              required
              min="0.01"
              step="0.01"
              placeholder="500"
              className={`input-field ${errors.price ? "border-theme-error" : ""}`}
              value={formData.price}
              onChange={(e) => {
                setFormData({ ...formData, price: e.target.value });
                if (errors.price) setErrors({ ...errors, price: "" });
              }}
            />
            {errors.price && (
              <p className="mt-1 text-sm text-theme-error">{errors.price}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-theme-heading mb-2">
              Delivery Days
            </label>
            <input
              type="number"
              required
              min="1"
              step="1"
              placeholder="7"
              className={`input-field ${errors.deliveryDays ? "border-theme-error" : ""}`}
              value={formData.deliveryDays}
              onChange={(e) => {
                setFormData({ ...formData, deliveryDays: e.target.value });
                if (errors.deliveryDays) setErrors({ ...errors, deliveryDays: "" });
              }}
            />
            {errors.deliveryDays && (
              <p className="mt-1 text-sm text-theme-error">{errors.deliveryDays}</p>
            )}
          </div>
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          disabled={loading}
          className="btn-primary w-full text-lg h-12 flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <Loader2 className="animate-spin" size={24} />
              Creating...
            </>
          ) : (
            "Publish Service"
          )}
        </button>
      </form>
    </div>
  );
}
