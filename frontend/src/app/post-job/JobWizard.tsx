"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Trash2,
  Tag,
  Loader2,
  ArrowRight,
  ArrowLeft,
  Eye,
} from "lucide-react";
import axios from "axios";
import { z } from "zod";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/Toast";
import { JOB_CATEGORIES, PAYMENT_TOKENS } from "@/constants/jobs";
import SkillCombobox from "@/components/SkillCombobox";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api/v1";
const PLATFORM_MIN_BUDGET_XLM = Number(
  process.env.NEXT_PUBLIC_PLATFORM_MIN_BUDGET_XLM || "1",
);

const milestoneSchema = z.object({
  title: z.string().min(3, "Milestone title is too short"),
  description: z.string().min(5, "Milestone description is too short"),
  amount: z
    .string()
    .refine(
      (value) => Number.parseFloat(value) >= PLATFORM_MIN_BUDGET_XLM,
      `Budget must be at least ${PLATFORM_MIN_BUDGET_XLM} XLM`,
    ),
  deadline: z.string().refine((value) => {
    if (!value) return false;
    const dt = new Date(value);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return !Number.isNaN(dt.getTime()) && dt > today;
  }, "Milestone deadline must be in the future"),
});

const step1Schema = z.object({
  title: z.string().min(10, "Title must be at least 10 characters").max(100),
  description: z
    .string()
    .min(50, "Description must be at least 50 characters")
    .max(5000),
  category: z.string().min(1, "Please select a category"),
  deadline: z.string().refine((value) => {
    if (!value) return false;
    const dt = new Date(value);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return !Number.isNaN(dt.getTime()) && dt > today;
  }, "Job deadline must be in the future"),
});

const step2Schema = z.object({
  milestones: z
    .array(milestoneSchema)
    .min(1, "At least one milestone is required")
    .max(20),
});

const fullSchema = step1Schema.merge(step2Schema);
type FormValues = z.infer<typeof fullSchema>;

const STORAGE_KEY = "job-wizard-draft";

/**
 * Stable idempotency key for a single publish attempt (#1125).
 *
 * The key is generated once and persisted in the draft, so that if the atomic
 * job-creation request fails and the user clicks "Publish Job" again, the retry
 * carries the SAME key. The backend then returns the original job instead of
 * creating a duplicate. It is only cleared once creation is confirmed complete.
 */
function getOrCreateIdempotencyKey(): string {
  try {
    const existing = localStorage.getItem(IDEMPOTENCY_KEY_STORAGE);
    if (existing) return existing;
  } catch {
    /* localStorage unavailable — fall through to a fresh key */
  }
  const key =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `job_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    localStorage.setItem(IDEMPOTENCY_KEY_STORAGE, key);
  } catch {
    /* ignore persistence failure; the in-memory key is still used this attempt */
  }
  return key;
}

const IDEMPOTENCY_KEY_STORAGE = "job-wizard-idempotency-key";

export default function JobWizard() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const { toast } = useToast();

  const [currentStep, setCurrentStep] = useState(1);
  const [skills, setSkills] = useState<string[]>([]);
  const [paymentToken, setPaymentToken] =
    useState<(typeof PAYMENT_TOKENS)[number]>("XLM");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  // Set once the job is confirmed created, so the draft auto-save effect below
  // stops re-persisting a draft we've just cleared on success (#1125).
  const [published, setPublished] = useState(false);

  // Today's date in YYYY-MM-DD format for date input min attribute
  const todayStr = new Date().toISOString().split("T")[0];

  // Load draft from localStorage
  useEffect(() => {
    const draft = localStorage.getItem(STORAGE_KEY);
    if (draft) {
      try {
        const parsed = JSON.parse(draft);
        if (parsed.skills) setSkills(parsed.skills);
        if (parsed.paymentToken) setPaymentToken(parsed.paymentToken);
      } catch {}
    }
  }, []);

  const {
    register,
    control,
    handleSubmit,
    watch,
    trigger,
    formState: { errors },
    setValue,
    getValues,
  } = useForm<FormValues>({
    resolver: zodResolver(fullSchema),
    mode: "onBlur",
    defaultValues: (() => {
      const draft =
        typeof window !== "undefined"
          ? localStorage.getItem(STORAGE_KEY)
          : null;
      if (draft) {
        try {
          const parsed = JSON.parse(draft);
          return (
            parsed.formData || {
              title: "",
              description: "",
              category: "",
              deadline: "",
              milestones: [
                { title: "", description: "", amount: "", deadline: "" },
              ],
            }
          );
        } catch {}
      }
      return {
        title: "",
        description: "",
        category: "",
        deadline: "",
        milestones: [{ title: "", description: "", amount: "", deadline: "" }],
      };
    })(),
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "milestones",
  });

  const milestones = watch("milestones");
  // Deliberately not memoized: watch() isn't guaranteed to return a new array
  // reference on every render it's read in, so a useMemo keyed on [milestones]
  // could (and did) compare equal by reference against stale content and skip
  // recomputing — silently showing an old total after editing a milestone
  // amount. The reduce itself is cheap enough that recomputing on every
  // render costs nothing.
  const totalBudget = milestones.reduce(
    (sum, m) => sum + (Number.parseFloat(m.amount) || 0),
    0,
  );

  // Save draft to localStorage. Skipped once the job is published so we don't
  // re-create a draft we intentionally cleared on success (#1125).
  useEffect(() => {
    if (published) return;
    const formData = getValues();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ formData, skills, paymentToken }),
    );
  }, [watch(), skills, paymentToken, getValues, published]);

  // Validate milestones total matches intended budget in real-time
  useEffect(() => {
    if (currentStep === 2 && totalBudget > 0) {
      // Real-time validation feedback shown via UI
    }
  }, [totalBudget, currentStep]);

  useEffect(() => {
    if (!isLoading && user !== null && user.role !== "CLIENT") {
      toast.error("Only clients can post jobs. Switch your role in Settings.");
      router.replace("/dashboard");
    }
  }, [isLoading, user, router, toast]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="animate-spin text-stellar-blue" size={48} />
      </div>
    );
  }

  if (user?.role !== "CLIENT") {
    return null;
  }

  const handleNext = async () => {
    // Validate only step 1's own fields — trigger() with no arguments
    // validates the full merged schema, including step 2's "at least one
    // milestone" requirement, which can never be satisfied yet since the
    // milestones screen hasn't been reached. That silently failed validation
    // and blocked the Next button with no visible error (nothing on this
    // step renders a milestones error).
    const isValid = await trigger(["title", "description", "category", "deadline"]);
    if (isValid) {
      setCurrentStep(2);
    }
  };

  const handleBack = () => {
    setCurrentStep(1);
  };

  const onSubmit = async (values: FormValues) => {
    setSubmitting(true);
    setError("");

    // One stable key for this publish attempt. Reused verbatim on retry so a
    // partial failure never produces a duplicate job (#1125).
    const idempotencyKey = getOrCreateIdempotencyKey();

    try {
      // Must match AuthContext's TOKEN_KEY ("stellarmarket_jwt"); the legacy
      // "token" key is never set, so it would send `Bearer null` and 401 for
      // every real logged-in user (issue #1125 review).
      const token = localStorage.getItem("stellarmarket_jwt");

      // Single atomic call: the backend creates the job and every milestone in
      // one transaction (all-or-nothing), so there is no window in which a job
      // exists with a partial milestone set. The budget is derived server-side
      // from the milestone amounts, so it can't diverge from what's persisted.
      const res = await axios.post(
        `${API_URL}/jobs/with-milestones`,
        {
          title: values.title,
          description: values.description,
          category: values.category,
          deadline: new Date(values.deadline).toISOString(),
          skills,
          paymentToken,
          idempotencyKey,
          milestones: values.milestones.map((m) => ({
            title: m.title,
            description: m.description,
            amount: Number.parseFloat(m.amount),
            dueDate: new Date(m.deadline).toISOString(),
          })),
        },
        { headers: { Authorization: `Bearer ${token}` } },
      );

      // Only now — with the full job+milestones confirmed persisted — clear the
      // draft and the idempotency key. On a failure both are intentionally kept
      // so the user can retry the same attempt without re-entering anything and
      // without risking a duplicate. `setPublished` first so the auto-save
      // effect can't immediately rewrite the draft we're about to remove.
      setPublished(true);
      localStorage.removeItem(STORAGE_KEY);
      try {
        localStorage.removeItem(IDEMPOTENCY_KEY_STORAGE);
      } catch {
        /* ignore */
      }
      router.push(`/jobs/${res.data.id}`);
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        // The validation middleware sends a generic top-level "Validation
        // failed" plus a detailed `errors: [{field, message}]` array — using
        // only the generic message left failures like "skills: at least one
        // skill is required" completely undiagnosable from the UI.
        const fieldErrors = err.response?.data?.errors as
          | { field: string; message: string }[]
          | undefined;
        const detail = fieldErrors?.length
          ? fieldErrors.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).join("; ")
          : undefined;
        setError(
          detail ||
            err.response?.data?.error ||
            err.response?.data?.message ||
            "Failed to post job. Your draft is saved — please try again.",
        );
      } else {
        setError(
          "An unexpected error occurred. Your draft is saved — please try again.",
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      {/* Progress indicator */}
      <div className="mb-8" role="navigation" aria-label="Job posting progress">
        <div className="flex items-center justify-center gap-2">
          {[
            { step: 1, label: "Job Details" },
            { step: 2, label: "Milestones" },
            { step: 3, label: "Preview" },
          ].map(({ step, label }, index) => (
            <div key={step} className="flex items-center">
              <button
                type="button"
                onClick={() => {
                  if (step < currentStep) {
                    setCurrentStep(step);
                  }
                }}
                disabled={step > currentStep}
                className={`w-10 h-10 rounded-full flex items-center justify-center font-semibold transition-all ${
                  currentStep === step
                    ? "bg-stellar-blue text-white ring-2 ring-stellar-blue ring-offset-2"
                    : currentStep > step
                    ? "bg-stellar-blue text-white hover:bg-stellar-purple cursor-pointer"
                    : "bg-theme-border text-theme-text cursor-not-allowed"
                }`}
                aria-current={currentStep === step ? "step" : undefined}
                aria-label={`${label}${
                  currentStep === step
                    ? " (current step)"
                    : currentStep > step
                    ? " (completed)"
                    : " (upcoming)"
                }`}
              >
                {step}
              </button>
              {index < 2 && (
                <div
                  className={`w-16 h-1 mx-2 transition-colors ${
                    currentStep > step ? "bg-stellar-blue" : "bg-theme-border"
                  }`}
                  aria-hidden="true"
                />
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-center gap-16 mt-3 text-sm">
          <span
            className={
              currentStep === 1
                ? "text-stellar-blue font-medium"
                : "text-theme-text"
            }
          >
            Job Details
          </span>
          <span
            className={
              currentStep === 2
                ? "text-stellar-blue font-medium"
                : "text-theme-text"
            }
          >
            Milestones
          </span>
          <span
            className={
              currentStep === 3
                ? "text-stellar-blue font-medium"
                : "text-theme-text"
            }
          >
            Preview
          </span>
        </div>
      </div>

      <form className="space-y-6" onSubmit={handleSubmit(onSubmit)}>
        {error && (
          <div className="p-3 rounded-lg bg-theme-error/10 border border-theme-error/20 text-theme-error text-sm">
            {error}
          </div>
        )}

        {/* Step 1: Basic Info */}
        {currentStep === 1 && (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold text-theme-heading">
              Job Details
            </h2>

            <div>
              <label className="block text-sm font-medium text-theme-heading mb-2">
                Job Title *
              </label>
              <input
                type="text"
                placeholder="e.g., Build Soroban DEX Frontend"
                className="input-field"
                {...register("title")}
              />
              {errors.title && (
                <p className="mt-1 text-xs text-theme-error">
                  {errors.title.message}
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-theme-heading mb-2">
                Description *
              </label>
              <textarea
                rows={6}
                placeholder="Describe the project requirements, scope, and deliverables..."
                className="input-field resize-none"
                {...register("description")}
              />
              {errors.description && (
                <p className="mt-1 text-xs text-theme-error">
                  {errors.description.message}
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-theme-heading mb-2">
                Category *
              </label>
              <select className="input-field" {...register("category")}>
                <option value="">Select a category</option>
                {JOB_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
              {errors.category && (
                <p className="mt-1 text-xs text-theme-error">
                  {errors.category.message}
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-theme-heading mb-2">
                Project Deadline *
              </label>
              <input
                type="date"
                className="input-field"
                min={todayStr}
                {...register("deadline")}
              />
              {errors.deadline && (
                <p className="mt-1 text-xs text-theme-error">
                  {errors.deadline.message}
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-theme-heading mb-2">
                Required Skills
              </label>
              <SkillCombobox skills={skills} onChange={setSkills} />
            </div>

            <button
              type="button"
              onClick={handleNext}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              Next: Milestones & Budget <ArrowRight size={20} />
            </button>
          </div>
        )}

        {/* Step 2: Milestones & Budget */}
        {currentStep === 2 && (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold text-theme-heading">
              Milestones & Budget
            </h2>

            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-theme-heading">
                Milestones
              </label>
              <button
                type="button"
                onClick={() =>
                  append({
                    title: "",
                    description: "",
                    amount: "",
                    deadline: "",
                  })
                }
                className="flex items-center gap-1 text-sm text-stellar-blue hover:text-stellar-purple"
              >
                <Plus size={16} /> Add Milestone
              </button>
            </div>

            <div className="space-y-4">
              {fields.map((field, index) => (
                <div key={field.id} className="card">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm font-medium text-stellar-purple">
                      Milestone {index + 1}
                    </span>
                    {milestones.length > 1 && (
                      <button
                        type="button"
                        onClick={() => remove(index)}
                        className="text-red-400 hover:text-red-300"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                  <div className="space-y-3">
                    <input
                      type="text"
                      placeholder="Milestone title"
                      className="input-field"
                      {...register(`milestones.${index}.title`)}
                    />
                    {errors.milestones?.[index]?.title && (
                      <p className="text-xs text-theme-error">
                        {errors.milestones[index]?.title?.message}
                      </p>
                    )}
                    <textarea
                      rows={2}
                      placeholder="Describe the deliverables"
                      className="input-field resize-none"
                      {...register(`milestones.${index}.description`)}
                    />
                    {errors.milestones?.[index]?.description && (
                      <p className="text-xs text-theme-error">
                        {errors.milestones[index]?.description?.message}
                      </p>
                    )}
                    <input
                      type="number"
                      placeholder="Amount (XLM)"
                      className="input-field"
                      min={PLATFORM_MIN_BUDGET_XLM}
                      step="0.0000001"
                      {...register(`milestones.${index}.amount`)}
                    />
                    {errors.milestones?.[index]?.amount && (
                      <p className="text-xs text-theme-error">
                        {errors.milestones[index]?.amount?.message}
                      </p>
                    )}
                    <input
                      type="date"
                      className="input-field"
                      min={todayStr}
                      {...register(`milestones.${index}.deadline`)}
                    />
                    {errors.milestones?.[index]?.deadline && (
                      <p className="text-xs text-theme-error">
                        {errors.milestones[index]?.deadline?.message}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="card bg-stellar-blue/5 border-stellar-blue/30">
              <div className="flex items-center justify-between">
                <span className="text-theme-heading font-semibold">
                  Total Budget
                </span>
                <span className="text-2xl font-bold text-stellar-blue">
                  {totalBudget.toLocaleString()} XLM
                </span>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleBack}
                className="btn-secondary flex-1 flex items-center justify-center gap-2"
              >
                <ArrowLeft size={20} /> Back
              </button>
              <button
                type="button"
                onClick={() => setCurrentStep(3)}
                className="btn-primary flex-1 flex items-center justify-center gap-2"
              >
                Preview & Publish <Eye size={20} />
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Preview */}
        {currentStep === 3 && (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold text-theme-heading">
              Preview & Publish
            </h2>

            <div className="card">
              <h3 className="text-xl font-bold text-theme-heading mb-2">
                {watch("title")}
              </h3>
              <p className="text-theme-text text-sm mb-4 whitespace-pre-wrap">
                {watch("description")}
              </p>
              <div className="flex flex-wrap gap-2 text-sm">
                <span className="bg-theme-border/40 px-3 py-1 rounded">
                  {watch("category")}
                </span>
                {skills.map((skill) => (
                  <span
                    key={skill}
                    className="bg-stellar-blue/10 text-stellar-blue px-3 py-1 rounded"
                  >
                    {skill}
                  </span>
                ))}
              </div>
            </div>

            <div className="card">
              <h4 className="font-semibold text-theme-heading mb-3">
                Milestones
              </h4>
              <div className="space-y-2">
                {milestones.map((m, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span className="text-theme-text">{m.title}</span>
                    <span className="font-semibold text-theme-heading">
                      {Number.parseFloat(m.amount).toLocaleString()} XLM
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-3 pt-3 border-t border-theme-border flex justify-between font-bold">
                <span className="text-theme-heading">Total</span>
                <span className="text-stellar-blue text-xl">
                  {totalBudget.toLocaleString()} XLM
                </span>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setCurrentStep(2)}
                className="btn-secondary flex-1 flex items-center justify-center gap-2"
              >
                <ArrowLeft size={20} /> Back
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="btn-primary flex-1 flex items-center justify-center gap-2"
              >
                {submitting ? (
                  <Loader2 className="animate-spin" size={20} />
                ) : (
                  "Publish Job"
                )}
              </button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
