import Swal, { type SweetAlertIcon, type SweetAlertOptions } from "sweetalert2";

/**
 * The single SweetAlert2 gateway (DESIGN.md §4). Every popup, confirmation,
 * and toast in the app must go through `notify.*` — direct `Swal.fire()`
 * calls are lint-banned outside this file (see eslint.config.mjs
 * `no-restricted-imports`).
 *
 * Guarantees provided here so call sites don't have to think about them:
 * - Theme-aware: colors come from the page's CSS variables, so light, dark,
 *   and high-contrast all render correctly with no per-call theming.
 * - `returnFocus: true` so keyboard/screen-reader users land back where
 *   they were, never orphaned.
 * - Reduced motion: `prefers-reduced-motion` disables show/hide animation
 *   classes entirely rather than just speeding them up.
 * - Popups are screen-reader announced by SweetAlert2's built-in aria wiring;
 *   we additionally keep confirmations keyboard-dismissable (Escape) except
 *   where a decision is required.
 */

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Empty show/hide animation classes — SweetAlert2 skips animating when these resolve to "". */
const noMotionClasses = { showClass: { popup: "" }, hideClass: { popup: "" } };

/**
 * Base config shared by every variant. Uses CSS custom properties (defined
 * per-theme in globals.css) instead of hard-coded colors so the popup
 * matches whichever of the three themes is active — including
 * high-contrast — without any JS theme detection here.
 */
function baseOptions(): SweetAlertOptions {
  const reducedMotion = prefersReducedMotion();

  return {
    returnFocus: true,
    heightAuto: false,
    background: "var(--popover)",
    color: "var(--popover-foreground)",
    confirmButtonColor: "var(--primary)",
    cancelButtonColor: "var(--secondary)",
    customClass: {
      popup: "font-sans",
      confirmButton: "!text-[var(--primary-foreground)]",
      cancelButton: "!text-[var(--secondary-foreground)]",
    },
    ...(reducedMotion ? noMotionClasses : {}),
  };
}

function fire(options: SweetAlertOptions) {
  // `SweetAlertOptions` is a discriminated union keyed off `input`; this
  // gateway never uses the `input` (prompt) variant, so merging two
  // options objects via spread is safe even though it defeats the
  // discriminant for the type checker. Cast back to the full union type.
  return Swal.fire({ ...baseOptions(), ...options } as SweetAlertOptions);
}

/** Toast mixin: top-end, auto-dismiss with a visible progress bar, pauses on hover/focus. */
function toastMixin() {
  return Swal.mixin({
    ...baseOptions(),
    toast: true,
    position: "top-end",
    showConfirmButton: false,
    timer: 4000,
    timerProgressBar: true,
    didOpen: (popup) => {
      popup.addEventListener("mouseenter", Swal.stopTimer);
      popup.addEventListener("mouseleave", Swal.resumeTimer);
      popup.addEventListener("focusin", Swal.stopTimer);
      popup.addEventListener("focusout", Swal.resumeTimer);
    },
  });
}

function success(title: string, text?: string) {
  return fire({ icon: "success", title, text });
}

function error(title: string, text?: string) {
  return fire({ icon: "error", title, text });
}

function warning(title: string, text?: string) {
  return fire({ icon: "warning", title, text });
}

function info(title: string, text?: string) {
  return fire({ icon: "info", title, text });
}

interface ConfirmOptions {
  title: string;
  text?: string;
  confirmButtonText?: string;
  cancelButtonText?: string;
  icon?: SweetAlertIcon;
  /** Marks the action as destructive/irreversible — swaps confirm color to destructive token. */
  destructive?: boolean;
}

/** Confirmation dialog. Resolves `true` only when the user affirmatively confirms. */
async function confirm(options: ConfirmOptions): Promise<boolean> {
  const result = await fire({
    icon: options.icon ?? "question",
    title: options.title,
    text: options.text,
    showCancelButton: true,
    confirmButtonText: options.confirmButtonText ?? "Confirm",
    cancelButtonText: options.cancelButtonText ?? "Cancel",
    confirmButtonColor: options.destructive ? "var(--destructive)" : "var(--primary)",
    focusCancel: options.destructive,
  });
  return result.isConfirmed;
}

interface ToastOptions {
  title: string;
  icon?: SweetAlertIcon;
}

function toast({ title, icon = "success" }: ToastOptions) {
  return toastMixin().fire({ icon, title });
}

/**
 * Low-stress, non-blocking variant for use inside a live exam session.
 * Deliberately never uses the "error"/red treatment — integrity nudges
 * during a timed exam should inform, not alarm (DESIGN.md: "calm
 * reconnecting state, never a scary failure"). Renders as a toast so it
 * never steals focus or interrupts typing.
 */
function examWarning(title: string, text?: string) {
  return toastMixin().fire({
    icon: "info",
    title,
    text,
    position: "top-end",
    timer: 6000,
    background: "var(--secondary)",
    color: "var(--secondary-foreground)",
    iconColor: "var(--foreground)",
  });
}

export const notify = {
  success,
  error,
  warning,
  info,
  confirm,
  toast,
  examWarning,
};
