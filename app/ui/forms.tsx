"use client";

import { createContext, useActionState, useContext, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";

import type { Result } from "@/app/actions";

/** A submit button that says what it is doing while the action runs. */
export function Submit({
  children,
  pending: pendingLabel,
  className = "btn primary",
  disabled,
  name,
  value,
  confirm,
}: {
  children: React.ReactNode;
  pending?: string;
  className?: string;
  disabled?: boolean;
  name?: string;
  value?: string;
  /** Asks first; for destructive buttons. */
  confirm?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={className}
      disabled={disabled || pending}
      name={name}
      value={value}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}

export function ResultLine({ result }: { result: Result }) {
  if (!result) return null;
  return (
    <span className={`result ${result.ok ? "ok" : "err"}`} role={result.ok ? "status" : "alert"}>
      {result.message}
    </span>
  );
}

const ResultContext = createContext<Result>(null);

/** Shows the enclosing ActionForm's result. Place it next to the submit button. */
export function FormResult() {
  return <ResultLine result={useContext(ResultContext)} />;
}

/**
 * A form wired to an action that returns a Result, which <FormResult /> shows beside
 * the button instead of throwing to an error page. Works from server components:
 * the fields are plain children.
 */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess,
  onSuccess,
}: {
  action: (prev: Result, fd: FormData) => Promise<Result>;
  children: React.ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  /** Client callers only. */
  onSuccess?: () => void;
}) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) {
      if (resetOnSuccess) ref.current?.reset();
      onSuccess?.();
    }
    // onSuccess is a callback prop; re-running on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, resetOnSuccess]);
  return (
    <ResultContext.Provider value={state}>
      <form ref={ref} action={formAction} className={className}>
        {children}
      </form>
    </ResultContext.Provider>
  );
}
